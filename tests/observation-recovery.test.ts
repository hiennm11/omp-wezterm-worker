import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { executionsOfRun, openExecution } from "../extensions/lib/executions.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { readObservations } from "../extensions/lib/observation-store.ts";
import { reattachNative } from "../extensions/lib/reattach-native.ts";
import { cleanup, delivered, fakeRuntime, makeDirs, nativeJob } from "./reattach-native-helpers.ts";

test("a saved background settlement lets a restored completed run end", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt, tick } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		openExecution(
			rt.openDb(),
			"ex-bg",
			job.id,
			"background",
			"Bash",
			"call-bg",
			"task-bg",
			"opened",
			"bridge",
			1000,
		);
		writeFileSync(
			join(sessionDir, `.wezterm-worker-reports-${job.id}.jsonl`),
			`${JSON.stringify({ runId: job.id, cycleId: "turn-1", state: "completed", result: "DONE" })}\n`,
		);
		const cycle = [
			{
				backend: "claude",
				runId: job.id,
				sessionId: "sess-1",
				source: "turn.start",
				payload: { turnId: "turn-1" },
			},
			{
				backend: "claude",
				runId: job.id,
				sessionId: "sess-1",
				source: "turn.complete",
				payload: { turnId: "turn-1", usage: null },
			},
			{
				backend: "claude",
				runId: job.id,
				sessionId: "sess-1",
				source: "background.settled",
				payload: { callId: "call-bg", taskId: "task-bg", status: "completed" },
			},
		];
		writeFileSync(
			join(sessionDir, `.wezterm-worker-observations-${job.id}.jsonl`),
			`${cycle.map((observation) => JSON.stringify(observation)).join("\n")}\n`,
		);
		await reattachNative(rt, job);
		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		await delivered(notified);
		assert.equal(job.status, "completed");
		assert.equal(executionsOfRun(rt.openDb(), job.id)[0].state, "settled");
	} finally {
		await cleanup(rt, dir);
	}
});

test("a completed report does not settle a background row without saved evidence", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt, tick } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		openExecution(
			rt.openDb(),
			"ex-bg",
			job.id,
			"background",
			"Bash",
			"call-bg",
			"task-bg",
			"opened",
			"bridge",
			1000,
		);
		writeFileSync(
			join(sessionDir, `.wezterm-worker-reports-${job.id}.jsonl`),
			`${JSON.stringify({ runId: job.id, cycleId: "turn-1", state: "completed", result: "DONE" })}\n`,
		);
		await reattachNative(rt, job);
		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		await delivered(notified);
		assert.equal(job.status, "running");
		assert.equal(executionsOfRun(rt.openDb(), job.id)[0].state, "open");
	} finally {
		await cleanup(rt, dir);
	}
});

test("replaying saved observations ignores duplicates and other runs", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		openExecution(
			rt.openDb(),
			"ex-bg",
			job.id,
			"background",
			"Bash",
			"call-bg",
			"task-bg",
			"opened",
			"bridge",
			1000,
		);
		const settlement = {
			backend: "claude",
			runId: job.id,
			sessionId: "sess-1",
			source: "background.settled",
			payload: { callId: "call-bg", taskId: "task-bg", status: "completed" },
		};
		writeFileSync(
			join(sessionDir, `.wezterm-worker-observations-${job.id}.jsonl`),
			`${JSON.stringify(settlement)}\n${JSON.stringify(settlement)}\n${JSON.stringify({ ...settlement, runId: "another-run" })}\n`,
		);
		await reattachNative(rt, job);
		const state = rt.claudeStates.get(job.id);
		assert.equal(state?.backgroundSettlements, 1);
		assert.equal(state?.seenObservations.size, 1);
		const row = executionsOfRun(rt.openDb(), job.id)[0];
		assert.equal(row.state, "settled");
		assert.equal(row.settlementEvidence, "background task completed");
	} finally {
		await cleanup(rt, dir);
	}
});

test("observation store preserves file order and skips malformed and foreign rows", () => {
	const { dir, sessionDir } = makeDirs();
	try {
		const file = join(sessionDir, ".wezterm-worker-observations-wz-1.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ runId: "wz-1", source: "background.started", payload: {} })}\nnot-json\n${JSON.stringify({ runId: "other", source: "background.settled", payload: {} })}\n${JSON.stringify({ runId: "wz-1", source: "background.settled", payload: {} })}\n`,
		);
		const observations = readObservations(sessionDir, "wz-1");
		assert.deepEqual(
			observations.map((observation) => observation.source),
			["background.started", "background.settled"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

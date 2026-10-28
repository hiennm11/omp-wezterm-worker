/**
 * The texts of a restored native run.
 *
 * The status and the delivery tell a reader that a restart cut the counts of
 * the run, and the status tells when the worker gave no snapshot.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { formatDelivery } from "../extensions/lib/deliver.ts";
import { freshRunState } from "../extensions/lib/job.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { snapshotNotice, turnsLabel } from "../extensions/lib/restored-run.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { cleanup, fakeRuntime, makeDirs, nativeJob } from "./reattach-native-helpers.ts";

interface FakeTool {
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

function fakeZod(): never {
	const chain = { optional: () => chain, describe: () => chain };
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

const USAGE = {
	worker: { state: "partial" as const, totals: null, cost: null, note: "" },
	request: { state: "unknown" as const, totals: null, cost: null, note: "" },
};

async function statusText(rt: WorkerRuntime): Promise<string> {
	const tools = new Map<string, FakeTool>();
	registerStatusTool({
		pi: { zod: fakeZod(), registerTool: (tool: FakeTool) => tools.set("status", tool) } as never,
		rt,
		deliver: () => undefined,
	});
	const result = await tools.get("status")?.execute("t1", {});
	return result?.content[0]?.text ?? "";
}

test("the turn label says that a restart cut the count", () => {
	assert.equal(turnsLabel(2, false), "2");
	assert.equal(turnsLabel(2, true), "2 since the restart");
});

test("the snapshot notice shows only for a restored run without a snapshot", () => {
	assert.equal(snapshotNotice(true, null), "no snapshot from the worker");
	assert.equal(snapshotNotice(true, 1000), null);
	assert.equal(snapshotNotice(false, null), null);
});

test("the delivery of a restored native run says since the restart", () => {
	const base = { ...freshRunState(0), id: "wz-1", label: "test", turns: 0 };
	const restored = { ...base, nativeUsage: { restoredAt: 5 } };
	assert.match(formatDelivery(restored as never, USAGE, 2), /turns: 2 since the restart/);
	assert.doesNotMatch(formatDelivery(base as never, USAGE, 2), /since the restart/);
	assert.match(formatDelivery(base as never, USAGE, 2), /turns: 2/);
});

test("the status of a live restored run names the missing snapshot", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		state.usage.restoredAt = 5;
		state.cycles.push("c1", "c2");
		rt.claudeStates.set(job.id, state);
		const text = await statusText(rt);
		assert.match(text, /turns\s+: 2 since the restart/);
		assert.match(text, /native\s+: .*no snapshot from the worker/);

		state.snapshotAt = 1000;
		const after = await statusText(rt);
		assert.doesNotMatch(after, /no snapshot from the worker/);
		assert.match(after, /turns\s+: 2 since the restart/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("the status of a run that never restarted shows no restart text", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		state.cycles.push("c1");
		rt.claudeStates.set(job.id, state);
		const text = await statusText(rt);
		assert.doesNotMatch(text, /since the restart/);
		assert.doesNotMatch(text, /no snapshot from the worker/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("the status of a finished restored run still says since the restart", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		job.status = "completed";
		job.nativeCycles = 3;
		job.nativeUsage = {
			turns: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
			calls: 1,
			callsWithoutUsage: 0,
			model: null,
			restoredAt: 5,
		};
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.match(text, /turns\s+: 3 since the restart/);
		assert.doesNotMatch(text, /no snapshot from the worker/);
	} finally {
		await cleanup(rt, dir);
	}
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, readOwnership } from "../extensions/lib/ownership.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import type { AgentDescriptor } from "../extensions/lib/subagent.ts";
import { createHost, RUNTIME, type TestHost } from "./harness.ts";
import { sessionContext } from "./session-context.ts";

const MAIN = "session-subagent-control-main";
const SUB = "session-subagent-control-sub";
const WORKER = "wz-subagent-control";
const PANE = "w1:p912";
const MAIN_AGENT: AgentDescriptor = { kind: "main", id: "main", depth: 0 };
const SUB_AGENT: AgentDescriptor = { kind: "sub", id: "sub-1", depth: 1 };
const panes = new Set([PANE]);

function ownership(stateDir: string) {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const row = readOwnership(db, taskKey(WORKER)).owner;
	db.close();
	return row;
}

async function stop(hosts: TestHost[], stateDir: string): Promise<void> {
	for (const host of hosts) await host.fire("session_shutdown", sessionContext(stateDir));
	rmSync(stateDir, { recursive: true, force: true });
}

test("a subagent can read a worker but cannot control it", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-control-"));
	const main = createHost({ stateDir, cwd: stateDir, sessionId: MAIN, agent: MAIN_AGENT });
	const sub = createHost({ stateDir, cwd: stateDir, sessionId: SUB, agent: SUB_AGENT });
	RUNTIME.herdr = async (args) => {
		if (args[0] === "pane" && args[1] === "list") {
			const listing = [...panes].map((pane_id) => ({ pane_id, tab_id: "w1:t1" }));
			return { code: 0, stdout: JSON.stringify({ result: { panes: listing } }), stderr: "" };
		}
		return { code: 0, stdout: "pane output", stderr: "" };
	};
	RUNTIME.exec = async () => ({ code: 0, stdout: "[]", stderr: "" });
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		await sub.fire("session_start", sessionContext(stateDir, SUB, SUB_AGENT));
		const job: Job = {
			id: WORKER,
			label: WORKER,
			task: "task",
			cwd: stateDir,
			model: null,
			tools: null,
			placement: "split",
			sessionDir: stateDir,
			sessionFile: null,
			worktreePath: null,
			worktreeBranch: null,
			worktreeOrigin: null,
			timeoutMs: 0,
			idleTimeoutMs: 0,
			closePaneOnFinish: true,
			...freshRunState(Date.now()),
			status: "running",
			paneId: PANE,
			runtime: "herdr",
			startedAt: Date.now(),
		};
		const db = openDatabase(join(stateDir, "lifecycle.db"));
		acquireOwnership(db, taskKey(WORKER), MAIN, process.pid, "2026-11-03T00:00:00.000Z", Date.now());
		persistRuns(db, MAIN, [job]);
		db.close();
		RUNTIME.jobs.set(WORKER, job);
		const before = ownership(stateDir);
		for (const [name, args] of [
			["wezterm_worker_steer", { workerId: WORKER, message: "change" }],
			["wezterm_worker_cancel", { workerId: WORKER }],
			["wezterm_worker_ack", { workerId: WORKER, eventId: "event", disposition: "accepted" }],
			["wezterm_worker_release", { workerId: WORKER }],
			["wezterm_worker_takeover", { workerId: WORKER }],
			["wezterm_worker_resolve", { workerId: WORKER, resolution: "completed", note: "done" }],
			["wezterm_worker_cleanup", { workerId: WORKER }],
			["wezterm_worker_resume", { workerId: WORKER }],
		] as const) {
			const result = await sub.call(name, args);
			assert.equal(
				sub.text(result),
				"A subagent cannot control a worker. Call this tool from the main session.",
				name,
			);
			assert.deepEqual(ownership(stateDir), before, `${name} changed the ownership row`);
			assert.equal(RUNTIME.jobs.get(WORKER)?.status, "running", `${name} changed worker status`);
			assert.deepEqual([...panes], [PANE], `${name} changed the pane list`);
		}
		assert.match(sub.text(await sub.call("wezterm_worker_status", {})), /wz-subagent-control/);
		assert.match(sub.text(await sub.call("wezterm_worker_peek", { workerId: WORKER })), /pane output/);
	} finally {
		await stop([sub, main], stateDir);
	}
});

test("the main session is not refused by the subagent rule", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-main-control-"));
	const main = createHost({ stateDir, cwd: stateDir, sessionId: MAIN, agent: MAIN_AGENT });
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		const result = await main.call("wezterm_worker_status", {});
		assert.notEqual(
			main.text(result),
			"A subagent cannot control a worker. Call this tool from the main session.",
		);
	} finally {
		await stop([main], stateDir);
	}
});

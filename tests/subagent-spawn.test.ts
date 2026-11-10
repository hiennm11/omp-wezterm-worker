/**
 * A subagent launch remains under the authority of the main session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorVerdict } from "../extensions/lib/monitor-authority.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, type Ownership, readOwnership } from "../extensions/lib/ownership.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import type { AgentDescriptor } from "../extensions/lib/subagent.ts";
import { createHost, RUNTIME, removeDir, sessionContext, type TestHost } from "./harness.ts";

/** The session of the main session. */
const MAIN = "session-main-spawn";

/** The session of the subagent of the second load. */
const SUBAGENT = "session-subagent-spawn";

/** The running worker of the main session. */
const MAIN_WORKER = "wz-subagent-spawn-main";

/** The start time of the process of the test. The ownership row holds it. */
const PROCESS_START = "2026-11-03T00:00:00.000Z";

/** The panes that the fake WezTerm holds. */
const panes = new Set<string>();

/** The main agent of the main session. */
const MAIN_AGENT: AgentDescriptor = { kind: "main", id: "main", name: "main", depth: 0 };

/** The subagent of the second load. */
const SUB_AGENT: AgentDescriptor = { kind: "sub", id: "sub-1", name: "SpawnFacts", depth: 1 };

/**
 * The answers of the programs that the extension starts.
 *
 * The process table holds no worker. The start time of the process of the
 * test is the value that the ownership row holds.
 */
const exec = async (_bin: string, args: string[]): Promise<RunResult> => {
	if (args.join(" ").includes("Get-CimInstance")) return { code: 0, stdout: "[]", stderr: "" };
	return { code: 0, stdout: PROCESS_START, stderr: "" };
};

/**
 * The answers of the fake WezTerm.
 *
 * The spawn gives a pane id. The pane stays in the list, so the monitor of
 * the worker does not end it.
 */
const wezterm = async (args: string[]): Promise<RunResult> => {
	if (args[0] === "pane" && args[1] === "list") {
		const listing = [...panes].map((pane_id) => ({ pane_id, tab_id: "w1:t1" }));
		return { code: 0, stdout: JSON.stringify({ result: { panes: listing } }), stderr: "" };
	}
	if ((args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create")) {
		const paneId = "w1:p21";
		panes.add(paneId);
		return {
			code: 0,
			stdout: JSON.stringify({ result: { pane: { pane_id: paneId, tab_id: "w1:t1" } } }),
			stderr: "",
		};
	}
	if (args[0] === "agent" && args[1] === "start") {
		return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
	}
	if (args[0] === "pane" && args[1] === "close") {
		panes.delete(args[2]);
		return { code: 0, stdout: "", stderr: "" };
	}
	return { code: 0, stdout: "", stderr: "" };
};

/**
 * The ownership row of a worker.
 *
 * The function closes the handle of the database, because a test that removes
 * the state directory must not hold a file lock.
 */
function ownerRowOf(stateDir: string, jobId: string): Ownership | null {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const owner = readOwnership(db, taskKey(jobId)).owner;
	db.close();
	return owner;
}

/**
 * A run of the main session.
 *
 * The ownership row names the session of the main session and the process of
 * the test, so the session takes the task again without a takeover.
 */
function seedRun(stateDir: string): Job {
	const job: Job = {
		id: MAIN_WORKER,
		label: "subagent-spawn-main",
		task: "Do the work of the task.",
		cwd: stateDir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join(stateDir, "sessions", MAIN_WORKER),
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: "w1:p20",
		runtime: "herdr",
		startedAt: Date.now(),
	};
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	acquireOwnership(db, taskKey(job.id), MAIN, process.pid, PROCESS_START, Date.now());
	persistRuns(db, MAIN, [job]);
	db.close();
	return job;
}

/**
 * Two loads of the extension in one process.
 *
 * The first load starts the main session. The second load starts a subagent
 * with another session id.
 */
function loadTwice(stateDir: string): { main: TestHost; subagent: TestHost } {
	seedRun(stateDir);
	panes.clear();
	panes.add("w1:p20");
	RUNTIME.exec = exec;
	RUNTIME.herdr = wezterm;

	const main = createHost({ stateDir, cwd: stateDir, sessionId: MAIN, agent: MAIN_AGENT });
	const subagent = createHost({ stateDir, cwd: stateDir, sessionId: SUBAGENT, agent: SUB_AGENT });
	return { main, subagent };
}

/**
 * The end of a test.
 *
 * The test starts no worker process, so the cleanup closes the database and
 * removes the state directory.
 */
async function endOfTest(hosts: TestHost[], stateDir: string): Promise<void> {
	for (const host of hosts) {
		await host.fire("session_shutdown", sessionContext(stateDir));
	}
	removeDir(stateDir);
}

test("a subagent that launches a worker keeps the main session", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-spawn-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT, SUB_AGENT));

		const mainOwner = ownerRowOf(stateDir, MAIN_WORKER);
		const result = await subagent.call("wezterm_spawn_worker", { task: "Do the work of the task." });
		const workerId = (result.details as { workerId?: string } | undefined)?.workerId;
		assert.ok(workerId, `the subagent started no worker: ${JSON.stringify(result.details)}`);
		assert.equal(RUNTIME.sessionId, MAIN, "the runtime stopped naming the main session");
		assert.equal(
			ownerRowOf(stateDir, workerId)?.sessionId,
			MAIN,
			"the new worker does not belong to the main session",
		);
		assert.equal(
			monitorVerdict(mainOwner, RUNTIME.sessionId),
			"act",
			"the main monitor lost authority of its worker",
		);
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

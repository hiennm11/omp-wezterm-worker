/**
 * The monitors of the main session when a subagent ends.
 *
 * OMP loads the extension again for a subagent in the same process. The
 * runtime lives at module scope, so the second load shares it. The shutdown
 * of the subagent must not stop the monitors of the main session, and it must
 * not close the database of the main session.
 *
 * The test loads the extension twice in one process. The first load starts
 * the main session with a running worker. The second load starts a subagent.
 * The shutdown of the subagent must leave the monitor of the worker alive.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import type { AgentDescriptor } from "../extensions/lib/subagent.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import {
	createHost,
	RUNTIME,
	removeDir,
	sessionContext,
	type TestHost,
} from "./harness.ts";

/** The session of the main session. */
const MAIN = "session-main-shutdown";

/** The session of the subagent of the second load. */
const SUBAGENT = "session-subagent-shutdown";

/** The running worker of the main session. */
const WORKER = "wz-subagent-shutdown-1";

/** The pane of the running worker. The fake WezTerm holds it. */
const PANE = 11;

/** The start time of the process of the test. The ownership row holds it. */
const PROCESS_START = "2026-11-03T00:00:00.000Z";

/** The panes that the fake WezTerm holds. */
const panes = new Set<number>();

/** The main agent of the main session. */
const MAIN_AGENT: AgentDescriptor = { kind: "main", id: "main", name: "main", depth: 0 };

/** The subagent of the second load. */
const SUB_AGENT: AgentDescriptor = { kind: "sub", id: "sub-1", name: "LivenessFacts", depth: 1 };

/**
 * The answers of the programs that the extension starts.
 *
 * The process table holds no worker. The start time of the process of the
 * test is the value that the ownership row holds, so the session of the test
 * takes the task of the worker without a takeover.
 */
const exec = async (_bin: string, args: string[]): Promise<RunResult> => {
	if (args.join(" ").includes("Get-CimInstance")) return { code: 0, stdout: "[]", stderr: "" };
	return { code: 0, stdout: PROCESS_START, stderr: "" };
};

/**
 * The answers of the fake WezTerm.
 *
 * The pane of the worker exists until a kill closes it.
 */
const wezterm = async (args: string[]): Promise<RunResult> => {
	if (args[0] === "list") {
		const listing = [...panes].map((pane_id) => ({ pane_id, tab_id: 1, window_id: 1 }));
		return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
	}
	if (args[0] === "kill-pane") {
		panes.delete(Number(args[args.indexOf("--pane-id") + 1]));
		return { code: 0, stdout: "", stderr: "" };
	}
	return { code: 0, stdout: "", stderr: "" };
};

/**
 * A run of the main session.
 *
 * The ownership row names the session of the main session and the process of
 * the test, so the session takes the task again without a takeover.
 */
function seedRun(stateDir: string): Job {
	const job: Job = {
		id: WORKER,
		label: "subagent-shutdown",
		task: "Do the work of the task.",
		cwd: stateDir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join(stateDir, "sessions", WORKER),
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
 * with another session id. The run of the main session sits in the state
 * directory, and the pane of the worker sits in the fake WezTerm.
 */
function loadTwice(stateDir: string): { main: TestHost; subagent: TestHost } {
	seedRun(stateDir);
	panes.clear();
	panes.add(PANE);
	RUNTIME.exec = exec;
	RUNTIME.wezterm = wezterm;

	const main = createHost({ stateDir, cwd: stateDir, sessionId: MAIN });
	const subagent = createHost({ stateDir, cwd: stateDir, sessionId: SUBAGENT });
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

test("the shutdown of a subagent keeps the monitors of the main session", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-shutdown-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT, SUB_AGENT));
		assert.ok(RUNTIME.monitors.has(WORKER), "the main session has no monitor of its worker");

		/* The subagent ends. Its shutdown must not touch the monitors of the
		   main session, because the runtime is shared by both sessions. */
		await subagent.fire("session_shutdown", sessionContext(stateDir, SUBAGENT, SUB_AGENT));

		assert.ok(
			RUNTIME.monitors.has(WORKER),
			"the shutdown of the subagent stopped the monitor of the main session",
		);
		assert.notEqual(RUNTIME.db, null, "the shutdown of the subagent closed the database");
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

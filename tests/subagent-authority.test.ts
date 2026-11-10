/**
 * The authority of the main session when a subagent loads the extension.
 *
 * OMP loads the extension again for a subagent in the same process. The
 * runtime lives at module scope, so the second load shares it. The session
 * start of the subagent must not bind the runtime to the session of the
 * subagent. The main session keeps the authority of its workers.
 *
 * The test loads the extension twice in one process. The first load starts
 * the main session. The second load starts a subagent with another session
 * id. The runtime must keep the session of the main session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { generationOf, taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, readOwnership } from "../extensions/lib/ownership.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import type { AgentDescriptor } from "../extensions/lib/subagent.ts";
import { createHost, RUNTIME, removeDir, sessionContext, type TestHost } from "./harness.ts";

/** The session of the main session. */
const MAIN = "session-main-subagent";

/** The session of the subagent of the second load. */
const SUBAGENT = "session-subagent-load";

/** The running worker of the main session. */
const WORKER = "wz-subagent-1";

/** The pane of the running worker. The fake WezTerm holds it. */
const PANE = "w1:p9";

/** The start time of the process of the test. The ownership row holds it. */
const PROCESS_START = "2026-11-03T00:00:00.000Z";

/** The panes that the fake WezTerm holds. */
const panes = new Set<string>();

/** The main agent of the main session. */
const MAIN_AGENT: AgentDescriptor = { kind: "main", id: "main", name: "main", depth: 0 };

/** The subagent of the second load. */
const SUB_AGENT: AgentDescriptor = { kind: "sub", id: "sub-1", name: "LeaseFacts", depth: 1 };

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
	if (args[0] === "pane" && args[1] === "list") {
		const listing = [...panes].map((pane_id) => ({ pane_id, tab_id: "w1:t1" }));
		return { code: 0, stdout: JSON.stringify({ result: { panes: listing } }), stderr: "" };
	}
	if (args[0] === "pane" && args[1] === "close") {
		panes.delete(args[2]);
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
		label: "subagent-authority",
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
 * with another session id. The run of the main session sits in the state
 * directory, and the pane of the worker sits in the fake WezTerm.
 */
function loadTwice(stateDir: string): { main: TestHost; subagent: TestHost } {
	seedRun(stateDir);
	panes.clear();
	panes.add(PANE);
	RUNTIME.exec = exec;
	RUNTIME.herdr = wezterm;

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

test("a subagent does not take the session of the main session", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		assert.equal(RUNTIME.sessionId, MAIN, "the main session did not bind its own session");

		/* The second load runs the session start of the subagent in the same
		   process. The runtime is shared, so the session id of the subagent
		   must not reach the main session. */
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT, SUB_AGENT));

		assert.equal(
			RUNTIME.sessionId,
			MAIN,
			`the runtime took the session of the subagent: ${JSON.stringify({ sessionId: RUNTIME.sessionId })}`,
		);
		assert.notEqual(generationOf(RUNTIME, WORKER), null, "the main session lost the authority of its worker");
		const db = openDatabase(join(stateDir, "lifecycle.db"));
		const owner = readOwnership(db, taskKey(WORKER)).owner;
		db.close();
		assert.equal(owner?.sessionId, MAIN, "the ownership of the worker moved to the subagent");
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a host without an agent keeps the main behaviour", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN));
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT));
		assert.equal(
			RUNTIME.sessionId,
			SUBAGENT,
			"a host without an agent did not bind the session of the subagent",
		);
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the session start logs the kind of the agent", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-subagent-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT, SUB_AGENT));

		const line = subagent.loggedInfos.find((text) => text.includes("session_start"));
		assert.ok(line, `the subagent logged no session start: ${JSON.stringify(subagent.loggedInfos)}`);
		assert.ok(line.includes("kind=sub"), `the log line names no subagent: ${line}`);
		assert.ok(line.includes("id=sub-1"), `the log line names no agent id: ${line}`);
		assert.ok(line.includes(`session=${SUBAGENT}`), `the log line names no session id: ${line}`);
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

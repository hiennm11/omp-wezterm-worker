/**
 * The authority of the main session after a second load of the extension.
 *
 * OMP loads the extension again for a subagent in the same process. The
 * runtime lives at module scope, so the second load shares it. The session
 * start of the subagent then binds the runtime to the session of the
 * subagent. The main session loses the authority of its workers, so the
 * monitor of the main session stops without a write and the worker outlives
 * its deadline.
 *
 * The test loads the extension twice in one process. The first load starts
 * the main session and a worker of that session. The second load starts a
 * subagent with another session id. The worker of the main session must keep
 * the authority and must end at its deadline.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorVerdict } from "../extensions/lib/monitor-authority.ts";
import { generationOf, taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, type Ownership, readOwnership } from "../extensions/lib/ownership.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { replayUndelivered } from "../extensions/lib/recover-task.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import type { AgentDescriptor } from "../extensions/lib/subagent.ts";
import { createHost, RUNTIME, removeDir, sessionContext, type TestHost, waitFor } from "./harness.ts";

/** The session of the main session. */
const MAIN = "session-main-load";

/** The session of the subagent of the second load. */
const SUBAGENT = "session-subagent-load";

/** The main agent of the main session. */
const MAIN_AGENT: AgentDescriptor = { kind: "main", id: "main", name: "main", depth: 0 };

/** The subagent of the second load. */
const SUB_AGENT: AgentDescriptor = { kind: "sub", id: "sub-1", name: "LeaseFacts", depth: 1 };

/** The running worker of the main session. */
const WORKER = "wz-second-load-1";

/** The finished worker of the main session. */
const DONE = "wz-second-load-2";

/** The pane of the running worker. The fake WezTerm holds it. */
const PANE = 7;

/** The deadline of the running worker. */
const DEADLINE_MS = 3_000;

/** The start time of the process of the test. The ownership row holds it. */
const PROCESS_START = "2026-11-03T00:00:00.000Z";

/** The panes that the fake WezTerm holds. */
const panes = new Set<number>();

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
 * The pane of the worker exists until a kill closes it. The kill removes the
 * pane, so a stop of the worker confirms that the pane is gone.
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
function seedRun(stateDir: string, overrides: Partial<Job> = {}): Job {
	const job: Job = {
		id: WORKER,
		label: "second-load",
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
		timeoutMs: DEADLINE_MS,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: PANE,
		startedAt: Date.now(),
		...overrides,
	};
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	acquireOwnership(db, taskKey(job.id), MAIN, process.pid, PROCESS_START, Date.now());
	persistRuns(db, MAIN, [job]);
	db.close();
	return job;
}

/** The status of a run in the state directory. */
function statusOf(stateDir: string, runId: string): string | null {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const row = db.handle.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
		| { status: string }
		| undefined;
	db.close();
	return row?.status ?? null;
}

/**
 * The runs that the replay of the session sends again.
 *
 * The function returns the runs that this session owns and never delivered.
 * A session without the ownership of a run gets an empty list.
 */
function replayable(stateDir: string): string[] {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const row = db.handle.prepare("SELECT payload FROM runs WHERE id = ?").get(DONE) as
		| { payload: string | null }
		| undefined;
	db.close();
	if (!row?.payload) return [];
	const job = JSON.parse(row.payload) as Job;
	return replayUndelivered(RUNTIME, [job], () => {}, null).map((entry) => entry.id);
}

/**
 * The owner of a worker.
 *
 * The function closes the handle of the database, because a test that removes
 * the state directory must not hold a file lock.
 */
function readOwnershipOf(stateDir: string, jobId: string): Ownership | null {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const owner = readOwnership(db, taskKey(jobId)).owner;
	db.close();
	return owner;
}

/**
 * The identity of the runtime, the owner of the worker, and the verdict of
 * the monitor.
 */
function authorityOf(stateDir: string): {
	sessionId: string | null;
	ownerSessionId: string | null;
	verdict: string;
} {
	const owner = readOwnershipOf(stateDir, WORKER);
	return {
		sessionId: RUNTIME.sessionId,
		ownerSessionId: owner?.sessionId ?? null,
		verdict: monitorVerdict(owner, RUNTIME.sessionId),
	};
}

/**
 * Two loads of the extension in one process.
 *
 * The first load starts the main session. The second load starts a subagent
 * with another session id. The runs of the main session sit in the state
 * directory, and the pane of the running worker sits in the fake WezTerm.
 */
function loadTwice(stateDir: string): { main: TestHost; subagent: TestHost } {
	seedRun(stateDir);
	seedRun(stateDir, {
		id: DONE,
		label: "second-load-done",
		status: "completed",
		finishedAt: Date.now(),
		result: "the old answer",
		paneId: null,
		timeoutMs: 0,
	});
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
 * removes the state directory. It does not ask WezTerm for its pane list,
 * because the test never opens a pane.
 */
async function endOfTest(hosts: TestHost[], stateDir: string): Promise<void> {
	for (const host of hosts) {
		await host.fire("session_shutdown", sessionContext(stateDir));
	}
	removeDir(stateDir);
}

test("the main session keeps the authority of its worker after a second load of the extension", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-second-load-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		assert.notEqual(
			generationOf(RUNTIME, WORKER),
			null,
			"the main session did not take the task of its worker",
		);
		assert.deepEqual(
			replayable(stateDir),
			[DONE],
			"the main session did not own the finished run of the replay",
		);

		/* The second load runs the session start of the subagent in the same
		   process. The runtime is shared, so the session id of the subagent
		   reaches the main session. */
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT, SUB_AGENT));

		const state = authorityOf(stateDir);
		assert.equal(
			RUNTIME.sessionId,
			MAIN,
			`the runtime took the session of the subagent: ${JSON.stringify(state)}`,
		);
		assert.notEqual(
			generationOf(RUNTIME, WORKER),
			null,
			`the main session lost the authority of its worker: ${JSON.stringify(state)}`,
		);
		assert.deepEqual(replayable(stateDir), [DONE], `the replay found no owned run: ${JSON.stringify(state)}`);
		assert.equal(
			monitorVerdict(readOwnershipOf(stateDir, WORKER), RUNTIME.sessionId),
			"act",
			`the monitor of the main session stopped without a write: ${JSON.stringify(state)}`,
		);
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a worker of the main session ends at its deadline after a second load of the extension", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-second-load-"));
	const { main, subagent } = loadTwice(stateDir);
	try {
		await main.fire("session_start", sessionContext(stateDir, MAIN, MAIN_AGENT));
		await subagent.fire("session_start", sessionContext(stateDir, SUBAGENT, SUB_AGENT));

		const ended = await waitFor(() => statusOf(stateDir, WORKER) === "failed", 20_000, 200);
		assert.ok(
			ended,
			`the worker of the main session outlived its deadline: ${JSON.stringify(authorityOf(stateDir))}`,
		);

		const messages = [...main.delivered, ...subagent.delivered];
		assert.ok(
			messages.some((text) => text.includes(WORKER)),
			`the main session got no result of its worker: ${JSON.stringify(messages)}`,
		);
	} finally {
		await endOfTest([main, subagent], stateDir);
		rmSync(stateDir, { recursive: true, force: true });
	}
});

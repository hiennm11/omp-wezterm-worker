/**
 * The tasks that a closing session releases.
 *
 * A main session that closes gives up the tasks that it still supervises. The
 * next process of the same session adopts the running worker through the
 * existing path of a released row.
 *
 * The test uses a host, so it proves the behaviour of the handler of the
 * extension. A row of a run that ended stays as it is.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { acquireTask, bindSession, generationOf, taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, type OwnerPhase } from "../extensions/lib/ownership.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { createHost, RUNTIME, removeDir, sessionContext, type TestHost } from "./harness.ts";

/** The session of the main session. */
const SESSION = "session-shutdown-release";

/** The running worker of the main session. */
const RUNNING = "wz-shutdown-release-1";

/** The worker that ended before the session closed. */
const ENDED = "wz-shutdown-release-2";

/** The pane of the running worker. The fake WezTerm holds it. */
const PANE = 21;

/** The start time of the process of the test. The ownership row holds it. */
const PROCESS_START = "2026-11-05T01:00:00.000Z";

/** The panes that the fake WezTerm holds. */
const panes = new Set<number>();

/**
 * The answers of the programs that the extension starts.
 *
 * The process table holds no worker. The start time of the process of the
 * test is the value that the ownership row holds, so the session of the test
 * holds the task of the worker.
 */
const exec = async (_bin: string, args: string[]): Promise<RunResult> => {
	if (args.join(" ").includes("Get-CimInstance")) return { code: 0, stdout: "[]", stderr: "" };
	return { code: 0, stdout: PROCESS_START, stderr: "" };
};

/**
 * The answers of the fake WezTerm.
 *
 * The pane of the running worker exists until a kill closes it.
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
 * the test.
 */
function seedRun(stateDir: string, id: string, status: Job["status"]): Job {
	const job: Job = {
		id,
		label: "shutdown-release",
		task: "Do the work of the task.",
		cwd: stateDir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join(stateDir, "sessions", id),
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status,
		paneId: status === "running" ? PANE : null,
		startedAt: Date.now(),
		finishedAt: status === "running" ? null : Date.now(),
	};
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	acquireOwnership(db, taskKey(id), SESSION, process.pid, PROCESS_START, Date.now());
	persistRuns(db, SESSION, [job]);
	db.close();
	return job;
}

/** The phase of the ownership row of a worker. */
function phaseOf(stateDir: string, jobId: string): OwnerPhase | null {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const row = db.handle.prepare("SELECT phase FROM ownership WHERE task_key = ?").get(taskKey(jobId)) as
		| { phase: string }
		| undefined;
	db.close();
	return (row?.phase as OwnerPhase | undefined) ?? null;
}

/**
 * A host with a running worker and a worker that ended.
 *
 * The state directory holds both runs. The pane of the running worker sits in
 * the fake WezTerm.
 */
function makeHost(stateDir: string): TestHost {
	seedRun(stateDir, RUNNING, "running");
	seedRun(stateDir, ENDED, "completed");
	panes.clear();
	panes.add(PANE);
	RUNTIME.exec = exec;
	RUNTIME.wezterm = wezterm;
	return createHost({ stateDir, cwd: stateDir, sessionId: SESSION });
}

test("a closing session releases the running worker and keeps the ended run", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-shutdown-release-"));
	const host = makeHost(stateDir);
	try {
		await host.fire("session_start", sessionContext(stateDir, SESSION));
		assert.equal(phaseOf(stateDir, RUNNING), "active", "the running worker is not owned before the close");

		await host.fire("session_shutdown", sessionContext(stateDir, SESSION));

		assert.equal(phaseOf(stateDir, RUNNING), "released", "the running worker was not released");
		assert.equal(phaseOf(stateDir, ENDED), "active", "the ended run lost its ownership");
	} finally {
		RUNTIME.closeDb();
		removeDir(stateDir);
	}
});

test("a closing session clears the monitors and closes the database", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-shutdown-monitors-"));
	const host = makeHost(stateDir);
	try {
		await host.fire("session_start", sessionContext(stateDir, SESSION));
		assert.ok(RUNTIME.monitors.size > 0, "the session watches no worker");

		await host.fire("session_shutdown", sessionContext(stateDir, SESSION));

		assert.equal(RUNTIME.monitors.size, 0, "the monitors of the session stay alive");
		assert.equal(RUNTIME.db, null, "the database of the session stays open");
	} finally {
		RUNTIME.closeDb();
		removeDir(stateDir);
	}
});

test("the shutdown of a subagent releases no task of the main session", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-shutdown-subagent-"));
	const host = makeHost(stateDir);
	try {
		await host.fire("session_start", sessionContext(stateDir, SESSION));
		const subagent = sessionContext(stateDir, SESSION, { kind: "sub", id: "sub-1", name: "Facts" });
		await host.fire("session_shutdown", subagent);

		assert.equal(phaseOf(stateDir, RUNNING), "active", "the subagent released the task of the main session");
	} finally {
		RUNTIME.closeDb();
		removeDir(stateDir);
	}
});

test("a new process of the same session adopts the worker of a closed session", async () => {
	/* The old process stays alive and closes its session. The new process of
	   the same session holds the lease of the session, because it wrote to
	   the session before the extension ran. The old process must release the
	   row, so the new process adopts the running worker. */
	const stateDir = mkdtempSync(join(tmpdir(), "wt-shutdown-adopt-"));
	const old = makeHost(stateDir);
	try {
		await old.fire("session_start", sessionContext(stateDir, SESSION));
		await old.fire("session_shutdown", sessionContext(stateDir, SESSION));
		assert.equal(phaseOf(stateDir, RUNNING), "released", "the running worker was not released");

		/* The new process of the same session. It holds the lease, because
		   it wrote to the session before the extension ran. */
		const fresh = createRuntime(exec);
		fresh.config.stateDir = stateDir;
		fresh.processId = process.pid + 1;
		fresh.processStartedAt = "2026-11-05T02:00:00.000Z";
		try {
			bindSession(fresh, { getSessionId: () => SESSION });
			fresh.sessionLeaseHeld = async () => true;
			const result = await acquireTask(fresh, RUNNING);
			assert.equal(result.acquired, true, result.acquired ? "" : result.reason);
			assert.equal(generationOf(fresh, RUNNING) !== null, true, "the new process holds no generation");
		} finally {
			fresh.closeDb();
		}
	} finally {
		RUNTIME.closeDb();
		removeDir(stateDir);
	}
});

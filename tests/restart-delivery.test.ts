/**
 * The delivery of a worker that lost its pane.
 *
 * A worker runs for a long time. Its pane closes, or OMP restarts. The main
 * session must learn that the worker ended. The result of the worker reaches
 * the main session, and the delivery leaves a row in the state `sent`.
 *
 * The test starts a main session that owns a running worker whose pane is
 * gone. A new main session with the same identity takes the task over. The
 * worker ends as `failed`, and the new main session delivers that result.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import { createHost, sessionContext } from "./harness.ts";

/** The session that owns the workers of the tests. */
const SESSION = "session-restart";

/** A pane id that no WezTerm pane has. The pane of the worker is gone. */
const GONE_PANE = 999_999;

/** A process id that no process has. The owner of the task is gone. */
const DEAD_PROCESS = 999_998;

/** The start time of the process that owned the task. */
const DEAD_START = "2026-10-23T01:00:00.000Z";

/** The worker of the tests. */
const WORKER = "wz-restart-1";

/**
 * A run that the state directory holds.
 *
 * The run row says that the worker runs in a pane. The ownership row names a
 * process that no longer exists, so a new session may take the task over.
 */
function seedRun(stateDir: string, overrides: Partial<Job> = {}): Job {
	const job: Job = {
		id: WORKER,
		label: "restart",
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
		closePaneOnFinish: false,
		...freshRunState(Date.now()),
		status: "running",
		paneId: GONE_PANE,
		startedAt: Date.now(),
		...overrides,
	};
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	acquireOwnership(db, taskKey(WORKER), SESSION, DEAD_PROCESS, DEAD_START, Date.now());
	persistRuns(db, SESSION, [job]);
	db.close();
	return job;
}

/** The delivery attempts of one run, under the job id and under the id of its result event. */
function deliveriesOf(stateDir: string, runId: string): Array<{ state: string; detail: string | null }> {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const rows = db.handle
		.prepare("SELECT state, detail FROM deliveries WHERE event_id IN (?, ?)")
		.all(runId, `ev-${runId}-result`) as Array<{
		state: string;
		detail: string | null;
	}>;
	db.close();
	return rows;
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

test("a new main session delivers the result of a worker that lost its pane", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-restart-"));
	const cwd = stateDir;
	seedRun(stateDir);

	const host = createHost({ stateDir, cwd, sessionId: SESSION });
	try {
		await host.fire("session_start", sessionContext(cwd, SESSION));

		assert.equal(statusOf(stateDir, WORKER), "failed", "the worker did not end as failed");
		const deliveries = deliveriesOf(stateDir, WORKER);
		assert.equal(
			deliveries.filter((row) => row.state === "sent").length,
			1,
			`the main session got no delivery: ${JSON.stringify(deliveries)}`,
		);
		assert.ok(
			host.delivered.some((text) => text.includes(WORKER)),
			`the main session got no message: ${JSON.stringify(host.delivered)}`,
		);
	} finally {
		await host.cleanup();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a worker that finished before the first recovery is not delivered again", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-restart-"));
	const cwd = stateDir;
	/* The worker ended before the session started. Its result reached the
	   main session of the old process, but the row of the delivery is gone. */
	seedRun(stateDir, {
		status: "completed",
		finishedAt: Date.now() - 60_000,
		result: "the old answer",
		paneId: null,
	});

	const host = createHost({ stateDir, cwd, sessionId: SESSION });
	try {
		await host.fire("session_start", sessionContext(cwd, SESSION));

		const deliveries = deliveriesOf(stateDir, WORKER);
		assert.deepEqual(deliveries, [], "the old run was delivered again");
		assert.deepEqual(host.delivered, [], "the main session got a message about the old run");
	} finally {
		await host.cleanup();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

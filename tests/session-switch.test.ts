import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, type OwnerPhase } from "../extensions/lib/ownership.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import { RUNTIME, createHost, removeDir, sessionContext } from "./harness.ts";

const OLD_SESSION = "session-switch-old";
const NEW_SESSION = "session-switch-new";
const WORKER = "wz-session-switch-1";

function seedWorker(stateDir: string): void {
	const job: Job = {
		id: WORKER,
		label: "session-switch",
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
		paneId: 21,
		startedAt: Date.now(),
		finishedAt: null,
	};
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	acquireOwnership(db, taskKey(WORKER), OLD_SESSION, process.pid, new Date().toISOString(), Date.now());
	persistRuns(db, OLD_SESSION, [job]);
	db.close();
}

function phaseOf(stateDir: string): OwnerPhase | null {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const row = db.handle.prepare("SELECT phase FROM ownership WHERE task_key = ?").get(taskKey(WORKER)) as
		| { phase: string }
		| undefined;
	db.close();
	return (row?.phase as OwnerPhase | undefined) ?? null;
}

test("a session switch releases the old session task and binds the new session", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-session-switch-"));
	const host = createHost({ stateDir, cwd: stateDir, sessionId: OLD_SESSION });
	try {
		seedWorker(stateDir);
		await host.fire("session_start", sessionContext(stateDir, OLD_SESSION));
		assert.equal(phaseOf(stateDir), "active");

		await host.fire("session_switch", sessionContext(stateDir, NEW_SESSION));

		assert.equal(RUNTIME.sessionId, NEW_SESSION, "the runtime keeps the old session id");
		assert.equal(phaseOf(stateDir), "released", "the old session task stays active");
	} finally {
		RUNTIME.closeDb();
		removeDir(stateDir);
	}
});

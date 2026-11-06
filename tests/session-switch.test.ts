import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { openDatabase } from "../extensions/lib/db.ts";
import type { EventCtx } from "../extensions/lib/host.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, type OwnerPhase } from "../extensions/lib/ownership.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { persistRuns } from "../extensions/lib/runs.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { switchSession } from "../extensions/lib/session-switch.ts";
import { createHost, RUNTIME, sessionContext } from "./harness.ts";

const OLD_SESSION = "session-switch-old";
const NEW_SESSION = "session-switch-new";
const WORKER = "wz-session-switch-1";
const PROCESS_START = "2026-11-05T01:00:00.000Z";

function setup(t: TestContext, ownerId = OLD_SESSION) {
	const stateDir = mkdtempSync(join(tmpdir(), "wt-session-switch-"));
	const rt = createRuntime(async (_bin, args) => {
		if (args.join(" ").includes("Get-CimInstance")) return { code: 0, stdout: "[]", stderr: "" };
		return { code: 0, stdout: PROCESS_START, stderr: "" };
	});
	t.after(() => {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	});
	rt.config.stateDir = stateDir;
	rt.processStartedAt = PROCESS_START;
	rt.wezterm = async (args): Promise<RunResult> =>
		args[0] === "list"
			? { code: 0, stdout: JSON.stringify([{ pane_id: 21, tab_id: 1, window_id: 1 }]), stderr: "" }
			: { code: 0, stdout: "", stderr: "" };
	rt.sessionLeaseHeld = async () => false;
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
	rt.jobs.set(WORKER, job);
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	acquireOwnership(db, taskKey(WORKER), ownerId, rt.processId, PROCESS_START, Date.now());
	db.close();
	return { rt, stateDir, job };
}

function phaseOf(stateDir: string): OwnerPhase | null {
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	const row = db.handle.prepare("SELECT phase FROM ownership WHERE task_key = ?").get(taskKey(WORKER)) as
		| { phase: string }
		| undefined;
	db.close();
	return (row?.phase as OwnerPhase | undefined) ?? null;
}

function context(sessionId: string, kind: "main" | "sub" = "main"): EventCtx {
	return {
		sessionManager: { getSessionId: () => sessionId },
		setInterval: () => ({ fake: true }) as unknown as NodeJS.Timeout,
		agent: { kind, id: kind === "sub" ? "sub-1" : "main", name: "test" },
	};
}

test("a session branch releases old tasks and binds the new id", async (t) => {
	const { rt, stateDir, job } = setup(t);
	RUNTIME.closeDb();
	RUNTIME.config.stateDir = stateDir;
	RUNTIME.processStartedAt = PROCESS_START;
	RUNTIME.exec = rt.exec;
	RUNTIME.wezterm = rt.wezterm;
	RUNTIME.sessionLeaseHeld = async () => false;
	const db = openDatabase(join(stateDir, "lifecycle.db"));
	persistRuns(db, OLD_SESSION, [job]);
	db.close();
	const host = createHost({ stateDir, cwd: stateDir, sessionId: OLD_SESSION });
	await host.fire("session_start", sessionContext(stateDir, OLD_SESSION));
	await host.fire("session_branch", sessionContext(stateDir, NEW_SESSION));
	assert.equal(RUNTIME.sessionId, NEW_SESSION);
	assert.equal(phaseOf(stateDir), "released");
	RUNTIME.closeDb();
	RUNTIME.jobs.clear();
	RUNTIME.monitors.clear();
});

test("the switch acquires and attaches tasks owned by the new session", async (t) => {
	const { rt, stateDir } = setup(t, NEW_SESSION);
	rt.sessionId = OLD_SESSION;
	await switchSession(rt, context(NEW_SESSION), () => {});
	assert.equal(rt.sessionId, NEW_SESSION);
	assert.equal(phaseOf(stateDir), "active");
	assert.ok(rt.monitors.has(WORKER));
});

test("a subagent switch does nothing", async (t) => {
	const { rt, stateDir } = setup(t);
	rt.sessionId = OLD_SESSION;
	await switchSession(rt, context(NEW_SESSION, "sub"), () => {});
	assert.equal(rt.sessionId, OLD_SESSION);
	assert.equal(phaseOf(stateDir), "active");
});

test("a monitor poll before session_switch keeps old ownership authority", (t) => {
	const { rt, stateDir, job } = setup(t);
	rt.sessionId = OLD_SESSION;
	const ticks: (() => void)[] = [];
	rt.timers = {
		setInterval: (fn) => {
			ticks.push(fn);
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	monitorJob(rt, job, () => {});
	const owner = rt
		.openDb()
		.handle.prepare("SELECT session_id, phase FROM ownership WHERE task_key = ?")
		.get(taskKey(WORKER)) as { session_id: string; phase: string };
	assert.equal(owner.session_id, OLD_SESSION);
	assert.equal(owner.phase, "active");
	ticks[0]?.();
	assert.equal(rt.sessionId, OLD_SESSION);
	assert.equal(phaseOf(stateDir), "active");
	assert.equal(job.status, "running");
});

/**
 * The event of a permission request of a Codex worker.
 *
 * A Codex worker asks the person for the approval of a command. The app
 * server sends the request, the translator turns it into an observation, and
 * the monitor raises the event `permission_request` for the owner. The
 * person answers the request in the pane, and the event is then resolved.
 *
 * The test drives the whole chain with the real messages of the Codex proof
 * of 2026-10-31. It shows that the database holds exactly one event for the
 * request, and that a second poll creates no second event.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyObservation,
	type ClaudeRunState,
	createClaudeRunState,
} from "../extensions/lib/claude-run-state.ts";
import {
	type CodexUsageState,
	emptyCodexUsage,
	translateCodexMessage,
} from "../extensions/lib/codex-events.ts";
import { eventsOfRun, pendingEvents } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { observeNative } from "../extensions/lib/native-ledger.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** One message of the app server, as the proof recorded it. */
interface RecordedMessage {
	source: string;
	payload: Record<string, unknown>;
}

/** The real messages of the proof. */
const MESSAGES = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "codex-messages.json"), "utf8"),
) as Record<string, RecordedMessage | RecordedMessage[]>;

/** One message of the proof that one key names. */
function messageOf(key: string): RecordedMessage {
	const value = MESSAGES[key];
	if (!value) throw new Error(`the fixture holds no message '${key}'`);
	return Array.isArray(value) ? value[0] : value;
}

/** A runtime whose polls run only when the test calls them. */
function fakeRuntime(stateDir: string): { rt: WorkerRuntime; tick: () => void } {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
	rt.config.stateDir = stateDir;
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, tick: () => tick() };
}

/** A running Codex worker with a session directory. */
function codexJob(sessionDir: string): Job {
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: "w1:p7",
		backend: "codex",
	};
}

/**
 * Send one message of the app server to the state of the run.
 *
 * The function translates the message and gives every observation to the
 * ledger of the run, so the state and the ledger hold the message.
 */
function sendMessage(
	state: ClaudeRunState,
	rt: WorkerRuntime,
	runId: string,
	message: RecordedMessage,
): void {
	const usage: CodexUsageState = emptyCodexUsage();
	for (const observation of translateCodexMessage(message, usage)) {
		observeNative(rt, state, runId, observation);
	}
}

/** The events of a run with the condition `permission_request`. */
function permissionEvents(rt: WorkerRuntime, runId: string): number {
	return eventsOfRun(rt.openDb(), runId).filter((event) => event.condition === "permission_request").length;
}

test("a Codex approval request raises one event of a permission request", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-permission-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(dir);
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		rt.claudeStates.set(job.id, state);

		/* The real message of the proof reaches the run state. */
		sendMessage(state, rt, job.id, messageOf("approvalRequest"));
		assert.equal(state.openApprovals.size, 1, "the request did not reach the state of the run");

		monitorNativeJob(rt, job, () => undefined);
		tick();

		const events = eventsOfRun(rt.openDb(), job.id);
		const permission = events.filter((event) => event.condition === "permission_request");
		assert.equal(permission.length, 1, "the run holds no single event of the request");
		assert.equal(permission[0].runId, job.id);
		assert.equal(pendingEvents(rt.openDb()).length, 1, "the event does not wait for the owner");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second poll of a Codex approval request creates no second event", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-permission-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(dir);
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		rt.claudeStates.set(job.id, state);

		sendMessage(state, rt, job.id, messageOf("approvalRequest"));
		monitorNativeJob(rt, job, () => undefined);
		tick();
		tick();
		tick();

		assert.equal(permissionEvents(rt, job.id), 1, "the polls created a second event of the request");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the completion of the command closes the request of a permission request", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-permission-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(dir);
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		rt.claudeStates.set(job.id, state);

		sendMessage(state, rt, job.id, messageOf("approvalRequest"));
		monitorNativeJob(rt, job, () => undefined);
		tick();
		assert.equal(permissionEvents(rt, job.id), 1);

		/* The real message of the proof ends the command. */
		sendMessage(state, rt, job.id, messageOf("commandItemCompleted"));

		assert.equal(state.openApprovals.size, 0, "the request stayed open");
		assert.equal(permissionEvents(rt, job.id), 1, "the event of the request is gone from the history");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the decision of the person resolves the event of a permission request", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-permission-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(dir);
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		rt.claudeStates.set(job.id, state);

		sendMessage(state, rt, job.id, messageOf("approvalRequest"));
		monitorNativeJob(rt, job, () => undefined);
		tick();
		assert.equal(permissionEvents(rt, job.id), 1);

		/* The person answered the request in the pane, so the tool check
		   reports the decision of the host. */
		applyObservation(state, {
			backend: "codex",
			runId: job.id,
			sessionId: null,
			source: "tool.check",
			payload: {
				callId: "exec-492ddd8e-0b98-488d-8cc5-4ae915817260",
				tool: "commandExecution",
				decision: "allow",
			},
		});
		tick();

		assert.equal(state.openApprovals.size, 0, "the request stayed open");
		assert.equal(pendingEvents(rt.openDb()).length, 0, "the event still waits for the owner");
		assert.equal(permissionEvents(rt, job.id), 1, "the resolved event is gone from the history");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

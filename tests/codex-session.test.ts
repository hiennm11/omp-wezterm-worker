/**
 * The session of a Codex worker.
 *
 * The session attaches the client of the app server to the run state of the
 * run. The owner sends a steering instruction through the queue of Codex.
 * The tests use the real messages of the Codex proof of 2026-10-31.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import type { CodexClient, CodexProtocolMessage } from "../extensions/lib/codex-client.ts";
import { attachCodexEvents, steerCodex } from "../extensions/lib/codex-session.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { registerSteerTool } from "../extensions/worker-tools/steer.ts";
import { nativeRuntime, toolOf } from "./native-run-helpers.ts";

/** One message of the app server, as the proof recorded it. */
interface RecordedMessage {
	source: string;
	payload: Record<string, unknown>;
}

/** The real messages of the proof. */
const MESSAGES = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "codex-messages.json"), "utf8"),
) as Record<string, RecordedMessage>;

/** The requests that the client received. */
interface RecordedRequest {
	method: string;
	params: Record<string, unknown>;
}

/** A client that records the requests of the test. */
function fakeClient(answer?: (method: string, params: Record<string, unknown>) => CodexProtocolMessage): {
	client: CodexClient;
	requests: RecordedRequest[];
	send: (message: CodexProtocolMessage) => void;
} {
	const requests: RecordedRequest[] = [];
	let handler: (message: CodexProtocolMessage) => void = () => undefined;
	return {
		client: {
			request: async (method: string, params: Record<string, unknown> = {}) => {
				requests.push({ method, params });
				return answer?.(method, params) ?? { id: 1, result: { turnId: "turn-1" } };
			},
			notify: () => undefined,
			close: () => undefined,
			setMessageHandler: (next: (message: CodexProtocolMessage) => void) => {
				handler = next;
			},
		},
		requests,
		send: (message: CodexProtocolMessage) => handler(message),
	};
}

/** A Codex worker that runs. */
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
		worktreeBranch: null,
		worktreeOrigin: null,
		worktreePath: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: 3,
		backend: "codex",
		nativeSessionId: "thread-1",
	} as Job;
}

test("the attachment stores the client of the run", () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, createClaudeRunState(job.id));
		const { client } = fakeClient();

		const attached = attachCodexEvents(rt, job, client);

		assert.equal(attached, true);
		assert.equal(rt.codexClients.get(job.id), client);
	} finally {
		rt.closeDb();
	}
});

test("the attachment does nothing when the run state does not exist", () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const { client } = fakeClient();

		const attached = attachCodexEvents(rt, job, client);

		assert.equal(attached, false);
		assert.equal(rt.codexClients.has(job.id), false);
	} finally {
		rt.closeDb();
	}
});

test("the messages of the app server fill the run state", () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, createClaudeRunState(job.id));
		const { client, send } = fakeClient();
		attachCodexEvents(rt, job, client);

		send({ method: MESSAGES.turnStarted1.source, params: MESSAGES.turnStarted1.payload });
		send({ method: MESSAGES.commandItemStarted.source, params: MESSAGES.commandItemStarted.payload });

		const state = rt.claudeStates.get(job.id);
		assert.ok(state);
		assert.deepEqual(state.cycles, ["turn-1"]);
		assert.equal(state.openCalls.size, 1);
	} finally {
		rt.closeDb();
	}
});

test("the delivery of an instruction removes it from the pending list", () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		const state = createClaudeRunState(job.id);
		state.currentCycleId = "turn-1";
		state.pendingInstructions.set("client-user-message-1", "client-user-message-1");
		rt.claudeStates.set(job.id, state);
		const { client, send } = fakeClient();
		attachCodexEvents(rt, job, client);

		send({ method: MESSAGES.steerItemStarted.source, params: MESSAGES.steerItemStarted.payload });

		assert.equal(state.pendingInstructions.size, 0);
		assert.equal(state.deliveredInstructions.size, 1);
	} finally {
		rt.closeDb();
	}
});

test("a steer adds a pending instruction", async () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		const state = createClaudeRunState(job.id);
		state.currentCycleId = "turn-1";
		rt.claudeStates.set(job.id, state);
		const { client, requests } = fakeClient();

		const outcome = await steerCodex(client, state, "thread-1", "Write QUEUED to queued.txt");

		assert.equal(outcome.ok, true);
		assert.equal(requests[0]?.method, "turn/steer");
		assert.equal(state.pendingInstructions.size, 1);
	} finally {
		rt.closeDb();
	}
});

test("a steer that the server refuses keeps nothing", async () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		const state = createClaudeRunState(job.id);
		state.currentCycleId = "turn-1";
		rt.claudeStates.set(job.id, state);
		const { client } = fakeClient(() => ({
			id: 1,
			error: { code: -1, message: "no running turn" },
		}));

		const outcome = await steerCodex(client, state, "thread-1", "Write QUEUED to queued.txt");

		assert.equal(outcome.ok, false);
		assert.match(outcome.error ?? "", /no running turn/);
		assert.equal(state.pendingInstructions.size, 0);
	} finally {
		rt.closeDb();
	}
});

test("a steer during an open approval is refused and keeps nothing", async () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		const state = createClaudeRunState(job.id);
		state.currentCycleId = "turn-1";
		state.openApprovals.set("exec-1", "commandExecution");
		rt.claudeStates.set(job.id, state);
		const { client, requests } = fakeClient();

		const outcome = await steerCodex(client, state, "thread-1", "Write QUEUED to queued.txt");

		assert.equal(outcome.ok, false);
		assert.match(outcome.error ?? "", /exec-1/);
		assert.equal(requests.length, 0);
		assert.equal(state.pendingInstructions.size, 0);
	} finally {
		rt.closeDb();
	}
});

test("a steer without a running turn is refused", async () => {
	const { rt, sessionDir } = nativeRuntime();
	try {
		const job = codexJob(sessionDir);
		const state = createClaudeRunState(job.id);
		rt.claudeStates.set(job.id, state);
		const { client, requests } = fakeClient();

		const outcome = await steerCodex(client, state, "thread-1", "Write QUEUED to queued.txt");

		assert.equal(outcome.ok, false);
		assert.equal(requests.length, 0);
	} finally {
		rt.closeDb();
	}
});

test("the steer tool sends the instruction to a Codex worker", async () => {
	const { rt, sessionDir } = nativeRuntime([3]);
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		state.currentCycleId = "turn-1";
		rt.claudeStates.set(job.id, state);
		const { client, requests } = fakeClient();
		rt.codexClients.set(job.id, client);

		const result = await toolOf(rt, registerSteerTool, "steer").execute("t1", {
			workerId: job.id,
			message: "Write QUEUED to queued.txt",
		});

		assert.equal(result.isError, undefined);
		assert.equal(requests[0]?.method, "turn/steer");
		assert.equal(state.pendingInstructions.size, 1);
		assert.match(result.content[0]?.text ?? "", /Queued for worker/);
	} finally {
		rt.closeDb();
	}
});

test("the steer tool refuses a Codex worker with an open approval", async () => {
	const { rt, sessionDir } = nativeRuntime([3]);
	try {
		const job = codexJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = createClaudeRunState(job.id);
		state.currentCycleId = "turn-1";
		state.openApprovals.set("exec-1", "commandExecution");
		rt.claudeStates.set(job.id, state);
		const { client, requests } = fakeClient();
		rt.codexClients.set(job.id, client);

		const result = await toolOf(rt, registerSteerTool, "steer").execute("t1", {
			workerId: job.id,
			message: "Write QUEUED to queued.txt",
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /exec-1/);
		assert.equal(requests.length, 0);
		assert.equal(state.pendingInstructions.size, 0);
	} finally {
		rt.closeDb();
	}
});

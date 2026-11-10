/**
 * The helpers of the tests of the events and the usage of a Codex worker.
 *
 * A Codex worker receives the messages of the app server of Codex. The
 * helper sends them through the real client of the extension, so a test
 * sees the observations that a real worker produces. The messages come from
 * the fixture of the proof, so no test writes a message from memory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BridgeObservation, type BridgeState, startBridge } from "../extensions/lib/claude-bridge.ts";
import { type ClaudeRunState, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import type { CodexClient, CodexProtocolMessage } from "../extensions/lib/codex-client.ts";
import { translateCodexMessage } from "../extensions/lib/codex-events.ts";
import { attachCodexEvents } from "../extensions/lib/codex-session.ts";
import { eventsOfRun } from "../extensions/lib/events.ts";
import { openExecution } from "../extensions/lib/executions.ts";
import { type CodexIdentity, freshRunState, type Job } from "../extensions/lib/job.ts";
import { observeNative } from "../extensions/lib/native-ledger.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";

/** One message of the app server, as the proof recorded it. */
export interface RecordedMessage {
	source: string;
	payload: Record<string, unknown>;
}

/** The real messages of the proof. */
const MESSAGES = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "codex-messages.json"), "utf8"),
) as Record<string, RecordedMessage | RecordedMessage[]>;

/** The messages of the proof that one key names. */
export function messagesOf(key: string): RecordedMessage[] {
	const value = MESSAGES[key];
	if (!value) throw new Error(`the fixture holds no message '${key}'`);
	return Array.isArray(value) ? value : [value];
}

/** One message of the proof that one key names. */
export function messageOf(key: string): RecordedMessage {
	return messagesOf(key)[0];
}

/** The id of the call that the approval request of the fixture names. */
export function approvalCallId(): string {
	const itemId = messageOf("approvalRequest").payload.itemId;
	assert.equal(typeof itemId, "string", "the fixture holds no call id of the approval request");
	return String(itemId);
}

/**
 * The observations of one message of the app server.
 *
 * The translator of the extension turns the message into these
 * observations. The test sends them to the run state, so the event comes
 * from the real code path.
 */
export function observationsOf(message: RecordedMessage): BridgeObservation[] {
	return translateCodexMessage(message, { turnId: null, base: null, turn: null, last: null });
}

/** A tool that the fake host records. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A zod stub that accepts every parameter object. */
export function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, boolean: () => chain, object: () => chain } as never;
}

/** The tool that the extension registers. */
export function toolOf(rt: WorkerRuntime, register: (deps: ToolDeps) => void, name: string): FakeTool {
	const tools = new Map<string, FakeTool>();
	register({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set(name, tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get(name);
	assert.ok(tool, `the ${name} tool was not registered`);
	return tool;
}

/** The ack tool of the extension. */
export function ackTool(rt: WorkerRuntime): FakeTool {
	return toolOf(rt, registerAckTool, "ack");
}

/** The status tool of the extension. */
export function statusTool(rt: WorkerRuntime): FakeTool {
	return toolOf(rt, registerStatusTool, "status");
}

/** The text that the status tool shows for the workers of a runtime. */
export async function statusText(rt: WorkerRuntime): Promise<string> {
	const result = await statusTool(rt).execute("t1", {});
	return result.content[0]?.text ?? "";
}

/**
 * A client of an app server that delivers the messages of the test.
 *
 * The client holds the handler of the extension, so a message of the test
 * reaches the run state the way a message of a real app server reaches it.
 */
export interface FakeCodexClient extends CodexClient {
	/** Deliver one message of the app server. */
	deliver: (message: RecordedMessage) => void;
}

/** Build a fake client of an app server. */
export function fakeClient(): FakeCodexClient {
	let handler: (message: CodexProtocolMessage) => void = () => undefined;
	return {
		request: async () => ({ id: 1, result: {} }),
		notify: () => undefined,
		close: () => undefined,
		setMessageHandler: (next) => {
			handler = next;
		},
		deliver: (message) => {
			handler({ method: message.source, params: message.payload });
		},
	};
}

/** A running Codex worker with a session directory. */
export function codexJob(sessionDir: string, overrides: Partial<Job> = {}): Job {
	return {
		id: "wz-codex-1",
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
		...overrides,
	};
}

/** A runtime whose polls run only when the test calls them. */
export function fakeRuntime(stateDir: string): { rt: WorkerRuntime; tick: () => void } {
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

/** The options of a Codex run of a test. */
export interface CodexRunOptions {
	/** The state directory of the run. A second run may share it. */
	stateDir?: string;
	/** The fields of the worker of the run. */
	job?: Partial<Job>;
}

/** One Codex run with a state, a session directory and a poll. */
export interface CodexRun {
	/** The runtime of the run. */
	rt: WorkerRuntime;
	/** The worker of the run. */
	job: Job;
	/** The state of the run. */
	state: ClaudeRunState;
	/** The state directory of the run. */
	dir: string;
	/** The bridge of the run. */
	bridge: BridgeState;
	/** Run one poll of the monitor. */
	tick: () => void;
	/** Send one message of the app server to the run. */
	send: (message: RecordedMessage) => void;
	/** Send a list of messages of the app server to the run. */
	sendAll: (messages: RecordedMessage[]) => void;
	/** Close the runtime and remove the directory of the test. */
	close: () => Promise<void>;
}

/**
 * Build a Codex run whose polls run only when the test calls them.
 *
 * The run holds the client of the app server, so a message of the test
 * reaches the run state the way a message of a real app server reaches it.
 */
export async function codexRun(options: CodexRunOptions = {}): Promise<CodexRun> {
	const dir = options.stateDir ?? mkdtempSync(join(tmpdir(), "wt-codex-events-"));
	const sessionDir = join(dir, "sessions", "wz-codex-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(dir);
	const job = codexJob(sessionDir, options.job ?? {});
	rt.jobs.set(job.id, job);
	const state = createClaudeRunState(job.id);
	rt.claudeStates.set(job.id, state);
	const client = fakeClient();
	attachCodexEvents(rt, job, client);
	const bridge = await startBridge(job.id, (observation) => {
		observeNative(rt, state, job.id, observation);
	});
	rt.bridges.set(job.id, bridge);
	return {
		rt,
		job,
		state,
		dir,
		bridge,
		tick,
		send: (message) => client.deliver(message),
		sendAll: (messages) => {
			for (const message of messages) client.deliver(message);
		},
		close: async () => {
			await bridge.close();
			rt.closeDb();
			if (options.stateDir === undefined) rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Send one observation to the bridge of a run.
 *
 * The bridge is the live channel of a native run. The worker of Codex posts
 * its reports to it, and the owner reads the state that it writes.
 */
export async function postObservation(bridge: BridgeState, observation: BridgeObservation): Promise<void> {
	const response = await fetch(`${bridge.baseUrl}/observations`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${bridge.token}`,
		},
		body: JSON.stringify(observation),
	});
	assert.equal(response.status, 202, "the bridge refused the observation");
}

/** The session that owns the worker of the tests. */
export const OWN = "session-codex-1";

/**
 * Open one execution row of a run.
 *
 * The row names a call that the worker never settled. The supervisor must
 * raise the event of the lost execution when the run stops.
 */
export function openRow(rt: WorkerRuntime, runId: string, callId: string): void {
	openExecution(
		rt.openDb(),
		`ex-${runId}-${callId}`,
		runId,
		"tool",
		"commandExecution",
		callId,
		null,
		"tool.call.opened",
		"bridge",
		1000,
	);
}

/** The events of a run with the given condition. */
export function eventsWithCondition(rt: WorkerRuntime, runId: string, condition: string): number {
	return eventsOfRun(rt.openDb(), runId).filter((event) => event.condition === condition).length;
}

/** The identity of a worker whose app server is gone. */
export function goneIdentity(): CodexIdentity {
	return {
		port: 0,
		serverPid: 0,
		threadId: "",
		serverPaneId: null,
		tuiPaneId: null,
		binaryPath: "",
		version: "",
	};
}

/**
 * A runtime whose polls run only when the test calls them.
 *
 * The function returns the poll. The test calls it to run one tick of the
 * monitor.
 */
export function fakeTick(rt: WorkerRuntime): () => void {
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return () => tick();
}

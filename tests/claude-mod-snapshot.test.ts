/**
 * The run snapshot of the Claude Code mod.
 *
 * A new owner starts with an empty memory of the run. The mod sends a
 * snapshot of its state to the owner when the address of the owner changes.
 * The mod sends the snapshot again until the owner accepts it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type ModDollar,
	type ModEvent,
	type ModHandler,
	type ModMatcher,
	type ModOn,
	register,
} from "../extensions/claude-mod/hooks/register.js";

/** One handler of the mod. */
type Handler = ModHandler;

/** The address that the launch gives to the worker. */
const LAUNCH_URL = "http://127.0.0.1:9999";
/** The token that the launch gives to the worker. */
const LAUNCH_TOKEN = "token-1";
/** The address of a new owner. */
const NEW_URL = "http://127.0.0.1:9998";
/** The path of the handover file. */
const HANDOVER_PATH = "/tmp/handover.json";

/** The response of a fake fetch. */
interface FetchResponse {
	ok: boolean;
	status: number;
	text: string;
}

/** The dollar of the host. Every posted body is recorded. */
type FakeDollar = ModDollar & {
	http: {
		fetch: (url: string, options?: { body?: string }) => Promise<FetchResponse>;
	};
	env: { get: (name: string) => Promise<string | null> };
	fs: { read: (path: string) => Promise<string | null> };
	session: { id: () => Promise<string | null> };
	tool: { register: () => Promise<void> };
	clock: { every: (ms: number, fn: () => Promise<void>) => Promise<void> };
	prompt: { submit: (input: { text: string }) => Promise<{ drop?: string | null }> };
};

/** The knobs of the fake host. */
interface FakeState {
	/** The text of the handover file, or null when the file is absent. */
	handover: string | null;
	/** The status that a post of an observation returns. */
	postStatus: number;
	/** True when a post of an observation throws. */
	postThrows: boolean;
	/** The command that the owner hands out, or null. */
	command: { id: string; text: string } | null;
}

/** The mod that the test drives. */
interface Mod {
	/** The handler of one event, or null when the mod has none. */
	handler(event: string): Handler | null;
	/** The dollar that the handlers of the mod use. */
	dollar: FakeDollar;
	/** The bodies that the mod posted. */
	bodies(): Array<{ source: string; payload: Record<string, unknown> }>;
	/** The payloads of the snapshots that the owner received. */
	snapshots(): Array<Record<string, unknown>>;
	/** The number of posts of a snapshot, also the failed ones. */
	snapshotAttempts(): number;
	/** Run one poll of the mod. */
	poll(): Promise<void>;
}

/** The text of a handover file for one address and one token. */
function handoverText(url: string, token: string): string {
	return JSON.stringify({ url, token });
}

/** The mod of one test, with its handlers ready. */
async function startMod(fake: FakeState): Promise<Mod> {
	const handlers = new Map<string, Handler>();
	const bodies: Array<{ source: string; payload: Record<string, unknown> }> = [];
	let attempts = 0;
	let pollFn: (() => Promise<void>) | null = null;
	const on: ModOn = (event: string, matcher: ModMatcher | ModHandler | undefined, handler?: ModHandler) => {
		if (typeof matcher === "function") {
			handlers.set(event, matcher);
			return;
		}
		handlers.set(`${event}:${matcher?.tool ?? ""}`, handler as Handler);
	};
	register(on);
	const env: Record<string, string> = {
		WEZTERM_WORKER_URL: LAUNCH_URL,
		WEZTERM_WORKER_TOKEN: LAUNCH_TOKEN,
		WEZTERM_WORKER_RUN_ID: "run-1",
		WEZTERM_WORKER_HANDOVER: HANDOVER_PATH,
	};
	const dollar: FakeDollar = {
		http: {
			fetch: async (url: string, options?: { body?: string }) => {
				if (url.includes("/commands")) {
					const command = fake.command;
					fake.command = null;
					return { ok: true, status: 200, text: JSON.stringify(command ? { command } : {}) };
				}
				const body = options?.body ? JSON.parse(options.body) : {};
				if (body.source === "state.snapshot") attempts += 1;
				if (fake.postThrows) throw new Error("the owner did not answer");
				if (fake.postStatus >= 300) return { ok: false, status: fake.postStatus, text: "{}" };
				bodies.push({ source: body.source, payload: body.payload ?? {} });
				return { ok: true, status: fake.postStatus, text: "{}" };
			},
		},
		env: { get: async (name: string) => env[name] ?? null },
		fs: { read: async () => fake.handover },
		session: { id: async () => "session-1" },
		tool: { register: async () => undefined },
		clock: {
			every: async (_ms: number, fn: () => Promise<void>) => {
				pollFn = fn;
			},
		},
		prompt: { submit: async () => ({}) },
	};
	const getPoll = (): (() => Promise<void>) => {
		if (!pollFn) throw new Error("the mod registers no poll");
		return pollFn;
	};
	const start = handlers.get("session.start");
	assert.ok(start, "the mod registers a session start handler");
	await start(dollar, { cwd: "/repo", isInteractive: true }, () => undefined);
	return {
		handler: (event) => handlers.get(event) ?? null,
		dollar,
		bodies: () => bodies,
		snapshots: () => bodies.filter((body) => body.source === "state.snapshot").map((body) => body.payload),
		snapshotAttempts: () => attempts,
		poll: async () => {
			const fn = getPoll();
			await fn();
		},
	};
}

/** The handler of one event of the mod. */
function handlerOf(mod: Mod, event: string): Handler {
	const handler = mod.handler(event);
	assert.ok(handler, `the mod registers a handler for ${event}`);
	return handler;
}

/** Open a call that stays open until the test releases it. */
function openCall(mod: Mod, callId: string): { settled: unknown; release: () => void } {
	const gate = Promise.withResolvers<void>();
	const settled = handlerOf(mod, "tool.call")(
		mod.dollar,
		{ tool_use_id: callId, tool: "Bash" },
		() => gate.promise,
	);
	return { settled, release: gate.resolve };
}

test("the first poll with the launch address sends no snapshot", async () => {
	const fake: FakeState = {
		handover: handoverText(LAUNCH_URL, LAUNCH_TOKEN),
		postStatus: 200,
		postThrows: false,
		command: null,
	};
	const mod = await startMod(fake);
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 0);
	assert.equal(mod.snapshots().length, 0);
	/* A later change of the address sends a snapshot, so the poll above was
	   not a poll without a snapshot. */
	fake.handover = handoverText(NEW_URL, LAUNCH_TOKEN);
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 1);
});

test("a change of the token of the owner sends one snapshot", async () => {
	const fake: FakeState = {
		handover: handoverText(LAUNCH_URL, "token-2"),
		postStatus: 200,
		postThrows: false,
		command: null,
	};
	const mod = await startMod(fake);
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 1);
	assert.equal(mod.snapshots().length, 1);
});

test("a change of the address of the owner sends one snapshot with the state of the run", async () => {
	const fake: FakeState = {
		handover: handoverText(LAUNCH_URL, LAUNCH_TOKEN),
		postStatus: 200,
		postThrows: false,
		command: { id: "cmd-1", text: "keep going" },
	};
	const mod = await startMod(fake);
	await handlerOf(mod, "turn.start")(mod.dollar, { turnId: "turn-1", text: "work" }, () => undefined);
	await mod.poll();
	const call = openCall(mod, "call-1");
	await handlerOf(mod, "tool.check")(
		mod.dollar,
		{ tool_use_id: "call-1", tool: "Bash" } as ModEvent,
		async () => ({ decision: "ask" }),
	);
	fake.handover = handoverText(NEW_URL, LAUNCH_TOKEN);
	await mod.poll();
	const snapshots = mod.snapshots();
	assert.equal(snapshots.length, 1);
	const payload = snapshots[0];
	assert.equal(typeof payload.takenAt, "number");
	assert.equal(payload.deliveredCycleId, "turn-1");
	assert.equal(payload.turnOpen, true);
	assert.equal(payload.pendingInstructionId, "claude-instruction-cmd-1");
	assert.deepEqual(payload.openCalls, [["call-1", "Bash"]]);
	assert.deepEqual(payload.pendingApprovals, [["call-1", "Bash"]]);
	call.release();
	await call.settled;
	await handlerOf(mod, "turn.start")(mod.dollar, { turnId: "turn-2", text: "work" }, () => undefined);
});

test("a failed snapshot is sent again and an accepted snapshot is not", async () => {
	const fake: FakeState = {
		handover: handoverText(NEW_URL, LAUNCH_TOKEN),
		postStatus: 200,
		postThrows: true,
		command: null,
	};
	const mod = await startMod(fake);
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 1);
	assert.equal(mod.snapshots().length, 0);
	fake.postThrows = false;
	fake.postStatus = 500;
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 2);
	assert.equal(mod.snapshots().length, 0);
	fake.postStatus = 200;
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 3);
	assert.equal(mod.snapshots().length, 1);
	await mod.poll();
	assert.equal(mod.snapshotAttempts(), 3);
	assert.equal(mod.snapshots().length, 1);
});

test("the snapshot holds the turn of the run", async () => {
	const fake: FakeState = {
		handover: handoverText(NEW_URL, LAUNCH_TOKEN),
		postStatus: 200,
		postThrows: false,
		command: null,
	};
	const mod = await startMod(fake);
	await handlerOf(mod, "turn.start")(mod.dollar, { turnId: "turn-1", text: "work" }, () => undefined);
	await mod.poll();
	assert.equal(mod.snapshots()[0]?.turnOpen, true);
	await handlerOf(mod, "turn.complete")(mod.dollar, { turnId: "turn-1" }, () => undefined);
	fake.handover = handoverText("http://127.0.0.1:9997", LAUNCH_TOKEN);
	await mod.poll();
	const snapshots = mod.snapshots();
	assert.equal(snapshots.length, 2);
	assert.equal(snapshots[1]?.turnOpen, false);
});

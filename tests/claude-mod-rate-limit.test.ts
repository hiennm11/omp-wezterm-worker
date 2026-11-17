/**
 * The rate limit of a Claude Code worker.
 *
 * The mod sends the path of the transcript when a turn ends with an error.
 * The owner reads the tail of that file, because the hook of the mod does
 * not carry the kind of the error.
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

/** The path that the host reports for the transcript. */
const TRANSCRIPT_PATH = "C:/Users/Admin/.claude/projects/C--repo/session-1.jsonl";

/** The mod that the test drives. */
interface Mod {
	/** The handler of one event, or null when the mod has none. */
	handler(event: string): Handler | null;
	/** The dollar that the handlers of the mod use. */
	dollar: ModDollar;
	/** The bodies that the mod posted. */
	bodies(): Array<{ source: string; payload: Record<string, unknown> }>;
}

/**
 * The dollar of the host.
 *
 * The host reports the path of the transcript. The call can fail, so the
 * fake takes a flag for it.
 */
function fakeDollar(
	bodies: Array<{ source: string; payload: Record<string, unknown> }>,
	infoFails = false,
): ModDollar {
	const env: Record<string, string> = {
		WEZTERM_WORKER_URL: "http://127.0.0.1:9999",
		WEZTERM_WORKER_TOKEN: "token-1",
		WEZTERM_WORKER_RUN_ID: "run-1",
	};
	return {
		http: {
			fetch: async (_url: string, options?: { body?: string }) => {
				const body = options?.body ? JSON.parse(options.body) : {};
				bodies.push({ source: body.source, payload: body.payload ?? {} });
				return { ok: true, status: 200, text: "{}" };
			},
		},
		env: { get: async (name: string) => env[name] ?? null },
		fs: { read: async () => null },
		session: {
			id: async () => "session-1",
			info: async () => {
				if (infoFails) throw new Error("the host refused the call");
				return { transcriptPath: TRANSCRIPT_PATH };
			},
		},
		tool: { register: async () => undefined },
		clock: { every: async () => undefined },
		prompt: { submit: async () => ({}) },
	};
}

/** The mod of one test, with its handlers ready. */
async function startMod(infoFails = false): Promise<Mod> {
	const handlers = new Map<string, Handler>();
	const bodies: Array<{ source: string; payload: Record<string, unknown> }> = [];
	const on: ModOn = (event: string, matcher: ModMatcher | ModHandler | undefined, handler?: ModHandler) => {
		if (typeof matcher === "function") {
			handlers.set(event, matcher);
			return;
		}
		handlers.set(`${event}:${matcher?.tool ?? ""}`, handler as ModHandler);
	};
	register(on);
	const dollar = fakeDollar(bodies, infoFails);
	const start = handlers.get("session.start");
	assert.ok(start, "the mod registers a session start handler");
	await start(dollar, { cwd: "/repo", isInteractive: true }, () => undefined);
	return {
		handler: (event) => handlers.get(event) ?? null,
		dollar,
		bodies: () => bodies,
	};
}

/** The bodies that the mod posted for one source. */
function ofSource(mod: Mod, source: string): Array<Record<string, unknown>> {
	return mod
		.bodies()
		.filter((body) => body.source === source)
		.map((body) => body.payload);
}

/** The event of a turn that ended with an error. */
function failedTurn(): ModEvent {
	return { turnId: "turn-1", reason: "error", usage: null };
}

/** The event of a turn that ended without an error. */
function goodTurn(): ModEvent {
	return { turnId: "turn-2", reason: "success", usage: null };
}

test("a failed turn sends the path of the transcript", async () => {
	const mod = await startMod();
	const handler = mod.handler("turn.complete");
	assert.ok(handler, "the mod registers a turn complete handler");
	await handler(mod.dollar, failedTurn(), () => undefined);

	const payloads = ofSource(mod, "turn.complete");
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0]?.transcriptPath, TRANSCRIPT_PATH);
});

test("a turn without an error sends no path", async () => {
	const mod = await startMod();
	const handler = mod.handler("turn.complete");
	assert.ok(handler, "the mod registers a turn complete handler");
	await handler(mod.dollar, goodTurn(), () => undefined);

	const payloads = ofSource(mod, "turn.complete");
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0]?.transcriptPath, null);
});

test("a failed host call sends a null path", async () => {
	const mod = await startMod(true);
	const handler = mod.handler("turn.complete");
	assert.ok(handler, "the mod registers a turn complete handler");
	await handler(mod.dollar, failedTurn(), () => undefined);

	const payloads = ofSource(mod, "turn.complete");
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0]?.transcriptPath, null);
});

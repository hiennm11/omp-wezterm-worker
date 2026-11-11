/**
 * The helpers of the note channel tests of a Claude Code worker.
 *
 * The tests drive the mod of a Claude Code worker against a real bridge.
 * The bridge serves the notes of the main session, so the test proves the
 * path of a note from the main session to the prompt of the worker.
 */

import assert from "node:assert/strict";

import {
	type ModDollar,
	type ModHandler,
	type ModMatcher,
	type ModOn,
	register,
} from "../extensions/claude-mod/hooks/register.js";

/** The handler of one event of the mod. */
export type Handler = ModHandler;

/** The tool that the mod registers. */
export interface RegisteredTool {
	name: string;
	description: string;
	inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

/** The bridge that the mod talks to. */
export interface FakeBridge {
	baseUrl: string;
	token: string;
}

/** The result that a tool handler of the mod returns. */
export interface ToolResult {
	result?: string;
	isError?: boolean;
}

/** The mod that the test drives. */
export interface FakeMod {
	/** The dollar that the handlers of the mod use. */
	dollar: ModDollar;
	/** The handler of one event, or null when the mod has none. */
	handler(event: string): Handler | null;
	/** The handler of one tool, or null when the mod has none. */
	toolHandler(tool: string): Handler | null;
	/** The tools that the mod registered. */
	tools(): RegisteredTool[];
	/** The prompts that the mod submitted. */
	submitted(): string[];
	/** The bodies that the mod posted to the bridge. */
	bodies(): Array<{ source: string; payload: Record<string, unknown> }>;
	/** The files that the mod wrote. */
	files(): Map<string, string>;
	/** Run one poll of the mod. */
	poll(): Promise<void>;
	/** Open a permission request that waits for the person. */
	askPermission(callId: string): Promise<void>;
	/** Settle the permission request of a call. */
	settlePermission(callId: string): Promise<void>;
}

/** The result that a tool handler of the mod returned. */
export function toolResult(value: unknown): ToolResult {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	const result = record.result;
	const isError = record.isError;
	return {
		result: typeof result === "string" ? result : undefined,
		isError: typeof isError === "boolean" ? isError : undefined,
	};
}

/**
 * The mod of one test, with its handlers ready.
 *
 * The mod talks to a real bridge. The host keeps the files of the mod in
 * memory, so the file of the notes survives the polls of one test.
 */
export async function startMod(bridge: FakeBridge, handoverPath: string): Promise<FakeMod> {
	const handlers = new Map<string, Handler>();
	const tools: RegisteredTool[] = [];
	const files = new Map<string, string>();
	const submitted: string[] = [];
	const bodies: Array<{ source: string; payload: Record<string, unknown> }> = [];
	let pollFn: (() => Promise<void>) | null = null;

	const on: ModOn = (event: string, matcher: ModMatcher | Handler | undefined, handler?: Handler) => {
		if (typeof matcher === "function") {
			handlers.set(event, matcher);
			return;
		}
		handlers.set(`${event}:${matcher?.tool ?? ""}`, handler as Handler);
	};
	register(on);

	const env: Record<string, string> = {
		WEZTERM_WORKER_URL: bridge.baseUrl,
		WEZTERM_WORKER_TOKEN: bridge.token,
		WEZTERM_WORKER_RUN_ID: "wz-1",
		WEZTERM_WORKER_HANDOVER: handoverPath,
	};

	const dollar: ModDollar = {
		env: { get: async (name: string) => env[name] ?? null },
		session: { id: async () => "session-1" },
		fs: {
			read: async (path: string) => {
				if (path === handoverPath) {
					return JSON.stringify({ url: bridge.baseUrl, token: bridge.token });
				}
				return files.get(path) ?? null;
			},
			write: async (path: string, text: string) => {
				files.set(path, text);
			},
		},
		http: {
			fetch: async (url: string, options?: { method?: string; body?: string }) => {
				if (options?.body) {
					const posted = JSON.parse(options.body) as {
						source?: string;
						payload?: Record<string, unknown>;
					};
					bodies.push({ source: posted.source ?? "unknown", payload: posted.payload ?? {} });
				}
				const response = await fetch(url, {
					method: options?.method ?? "GET",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${bridge.token}`,
					},
					body: options?.body,
				});
				return { ok: response.ok, status: response.status, text: await response.text() };
			},
		},
		tool: {
			register: async (tool: RegisteredTool) => {
				tools.push(tool);
			},
		},
		clock: {
			every: async (_ms: number, fn: () => Promise<void>) => {
				pollFn = fn;
			},
		},
		prompt: {
			submit: async (input: { text: string }) => {
				submitted.push(input.text);
				return {};
			},
		},
	};

	const start = handlers.get("session.start");
	assert.ok(start, "the mod registers a session start handler");
	await start(dollar, { cwd: "/repo", isInteractive: false }, () => undefined);

	const poll = async (): Promise<void> => {
		assert.ok(pollFn, "the mod registers no poll");
		await pollFn();
	};

	return {
		dollar,
		handler: (event) => handlers.get(event) ?? null,
		toolHandler: (tool) => handlers.get(`tool.call:${tool}`) ?? null,
		tools: () => tools,
		submitted: () => submitted,
		bodies: () => bodies,
		files: () => files,
		poll,
		askPermission: async (callId: string) => {
			const handler = handlers.get("tool.check");
			assert.ok(handler, "the mod registers a tool check handler");
			await handler(dollar, { tool_use_id: callId, tool: "Bash" }, async () => ({
				decision: "ask",
			}));
		},
		settlePermission: async (callId: string) => {
			const handler = handlers.get("tool.call");
			assert.ok(handler, "the mod registers a tool call handler");
			await handler(dollar, { tool_use_id: callId, tool: "Bash" }, async () => ({ isError: false }));
		},
	};
}

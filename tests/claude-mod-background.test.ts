/**
 * The background tasks of the Claude Code mod.
 *
 * The mod forwards the flag of a background call, the ids of a task and the
 * status of its notification. A text that does not match gives null, and the
 * mod never throws.
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

/** The mod that the test drives. */
interface Mod {
	/** The handler of one event, or null when the mod has none. */
	handler(event: string): Handler | null;
	/** The dollar that the handlers of the mod use. */
	dollar: ModDollar;
	/** The bodies that the mod posted. */
	bodies(): Array<{ source: string; payload: Record<string, unknown> }>;
}

/** The dollar of the mod. Every posted body is recorded. */
function fakeDollar(bodies: Array<{ source: string; payload: Record<string, unknown> }>): ModDollar {
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
		session: { id: async () => "session-1" },
		tool: { register: async () => undefined },
		clock: { every: async () => undefined },
		prompt: { submit: async () => ({}) },
	};
}

/** The mod of one test, with its handlers ready. */
async function startMod(): Promise<Mod> {
	const handlers = new Map<string, Handler>();
	const bodies: Array<{ source: string; payload: Record<string, unknown> }> = [];
	const on: ModOn = (event: string, matcher: ModMatcher | ModHandler | undefined, handler?: ModHandler) => {
		if (typeof matcher === "function") {
			handlers.set(event, matcher);
			return;
		}
		const tool = matcher?.tool ?? "";
		handlers.set(`${event}:${tool}`, handler as Handler);
	};
	register(on);
	const dollar = fakeDollar(bodies);
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

/** The row of the result of a background call. */
function bashResultRow(taskId = "b9sc69vt8"): ModEvent {
	return {
		uuid: "row-1",
		door: "prompt",
		origin: { kind: "tool", tool: "Bash" },
		message: {
			role: "user",
			content: [
				{
					tool_use_id: "toolu_01AXV1mqUmoMbmMwGAKkpNfo",
					type: "tool_result",
					content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output. You will be notified when it completes.`,
				},
			],
		},
	};
}

/** The row of the result of a stop of a task. */
function taskStopRow(taskId = "bz6x2vjdv"): ModEvent {
	return {
		uuid: "row-2",
		door: "prompt",
		origin: { kind: "tool", tool: "TaskStop" },
		message: {
			role: "user",
			content: [
				{
					tool_use_id: "toolu_01STOP",
					type: "tool_result",
					content: `{"message":"Successfully stopped task: ${taskId} (sleep 600)","task_id":"${taskId}","task_type":"local_bash","command":"sleep 600"}`,
				},
			],
		},
	};
}

/** The row of the notification of a task. */
function notificationRow(status: string): ModEvent {
	return {
		uuid: "row-3",
		door: "prompt",
		origin: { kind: "task-notification", tool: null },
		message: {
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"<task-id>bh20m30v0</task-id>",
						"<tool-use-id>toolu_01AXV1mqUmoMbmMwGAKkpNfo</tool-use-id>",
						"<output-file>/tmp/bh20m30v0.output</output-file>",
						`<status>${status}</status>`,
						'<summary>Background command "sleep 12" failed with exit code 3</summary>',
					].join("\n"),
				},
			],
		},
	};
}

test("a background call posts the background flag", async () => {
	const mod = await startMod();
	const handler = mod.handler("tool.call");
	assert.ok(handler);
	const result = { isError: false };
	const returned = await handler(
		mod.dollar,
		{
			tool_use_id: "toolu_01BG",
			tool: "Bash",
			command: "sleep 12",
			description: "Sleep 12 seconds",
			run_in_background: true,
		},
		() => result,
	);
	assert.equal(returned, result, "the handler returns the result of next");
	const opened = ofSource(mod, "tool.call.opened");
	assert.equal(opened.length, 1);
	assert.equal(opened[0].background, true);
});

test("a foreground call posts no background flag", async () => {
	const mod = await startMod();
	const handler = mod.handler("tool.call");
	assert.ok(handler);
	await handler(mod.dollar, { tool_use_id: "toolu_01FG", tool: "Bash", command: "echo hi" }, () => ({
		isError: false,
	}));
	const opened = ofSource(mod, "tool.call.opened");
	assert.equal(opened.length, 1);
	assert.equal("background" in opened[0], false);
});

test("the result of a background call posts the started observation", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(mod.dollar, bashResultRow(), () => undefined);
	const started = ofSource(mod, "background.started");
	assert.equal(started.length, 1);
	assert.equal(started[0].callId, "toolu_01AXV1mqUmoMbmMwGAKkpNfo");
	assert.equal(started[0].taskId, "b9sc69vt8");
});

test("the result of a stop posts the stopped observation", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(mod.dollar, bashResultRow(), () => undefined);
	await handler(mod.dollar, taskStopRow(), () => undefined);
	const stopped = ofSource(mod, "background.stopped");
	assert.equal(stopped.length, 1);
	assert.equal(stopped[0].taskId, "bz6x2vjdv");
});

test("a stop of an unknown task posts no call id", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(mod.dollar, taskStopRow(), () => undefined);
	const stopped = ofSource(mod, "background.stopped");
	assert.equal(stopped.length, 1);
	assert.equal(stopped[0].callId, null);
});

test("a stop names the call that started its task", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(mod.dollar, bashResultRow("b9sc69vt8"), () => undefined);
	await handler(mod.dollar, taskStopRow("b9sc69vt8"), () => undefined);
	const stopped = ofSource(mod, "background.stopped");
	assert.equal(stopped.length, 1);
	assert.equal(stopped[0].callId, "toolu_01AXV1mqUmoMbmMwGAKkpNfo");
	assert.equal(stopped[0].taskId, "b9sc69vt8");
});

test("a notification posts the settled observation with its ids", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(mod.dollar, notificationRow("completed"), () => undefined);
	const settled = ofSource(mod, "background.settled");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].callId, "toolu_01AXV1mqUmoMbmMwGAKkpNfo");
	assert.equal(settled[0].taskId, "bh20m30v0");
	assert.equal(settled[0].status, "completed");
});

test("a failed notification posts its status", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(mod.dollar, notificationRow("failed"), () => undefined);
	const settled = ofSource(mod, "background.settled");
	assert.equal(settled[0].status, "failed");
});

test("a notification without the tags posts null fields", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	const row = notificationRow("completed");
	const message = row.message as { content: Array<{ text: string }> };
	message.content[0].text = "a notification without the tags";
	await handler(mod.dollar, row, () => undefined);
	const settled = ofSource(mod, "background.settled");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].callId, null);
	assert.equal(settled[0].taskId, null);
	assert.equal(settled[0].status, null);
});

test("a row of another kind posts none of the background observations", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	await handler(
		mod.dollar,
		{
			uuid: "row-4",
			door: "prompt",
			origin: { kind: "assistant" },
			message: { role: "assistant", content: [] },
		},
		() => undefined,
	);
	assert.equal(ofSource(mod, "background.started").length, 0);
	assert.equal(ofSource(mod, "background.stopped").length, 0);
	assert.equal(ofSource(mod, "background.settled").length, 0);
});

test("the session append handler returns the result of next", async () => {
	const mod = await startMod();
	const handler = mod.handler("session.append");
	assert.ok(handler);
	const result = { keep: true };
	const returned = await handler(mod.dollar, bashResultRow(), () => result);
	assert.equal(returned, result);
});

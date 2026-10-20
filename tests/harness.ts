/**
 * A test host for the extension.
 *
 * The extension registers its tools with the host. The host records them, so
 * a test can call a tool the same way the agent calls it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionFiles } from "../extensions/lib/transcript.ts";
import extension from "../extensions/wezterm-worker.ts";

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface ToolDef {
	name: string;
	execute: (
		id: string,
		args: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<ToolResult>;
}

export interface EventHandler {
	event: string;
	handler: (event: unknown, ctx: unknown) => void | Promise<void>;
}

export interface TestHost {
	tools: Map<string, ToolDef>;
	handlers: EventHandler[];
	delivered: string[];
	labels: string[];
	stateDir: string;
	/** The panes that this host created. */
	panes: Set<number>;
	/** Run every handler for one event. */
	fire(event: string, ctx: unknown): Promise<void>;
	/** Call a tool by name. */
	call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
	/** The text of a tool result. */
	text(result: ToolResult): string;
	/** Close the panes that this host created and remove the state directory. */
	cleanup(): Promise<void>;
}

/** A schema object that accepts anything. The host validates the arguments. */
function schema(): Record<string, unknown> {
	const self: Record<string, unknown> = {};
	self.optional = () => self;
	self.describe = () => self;
	return self;
}

/**
 * Remove a directory.
 *
 * A worker process holds its own working directory open, so the delete can
 * fail with EBUSY. The retry waits for the process to let go.
 */
export function removeDir(path: string): void {
	rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/** Close a pane. A pane that is already gone is not an error. */
export function closePane(paneId: number): void {
	try {
		execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)], {
			stdio: "ignore",
			windowsHide: true,
		});
	} catch {
		/* the pane may already be gone */
	}
}

/** The pane ids that WezTerm reports now. */
export function currentPanes(): number[] {
	try {
		const out = execFileSync("wezterm", ["cli", "list", "--format", "json"], {
			encoding: "utf8",
			windowsHide: true,
		});
		const panes = JSON.parse(out) as Array<{ pane_id: number }>;
		return panes.map((p) => p.pane_id);
	} catch {
		return [];
	}
}

/**
 * Close the panes and wait for them to go.
 *
 * The worker process needs a moment to exit after its pane closes. The
 * directory that the worker used cannot be removed until then.
 */
export async function closePanesAndWait(paneIds: Iterable<number>, timeoutMs = 30_000): Promise<void> {
	const ids = [...paneIds];
	for (const paneId of ids) closePane(paneId);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = currentPanes();
		if (ids.every((id) => !open.includes(id))) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/**
 * Build a host with the extension loaded.
 *
 * `stateDir` holds the registry and the transcripts. The environment is set
 * before the extension reads its config.
 */
export function createHost(options: { stateDir?: string; cwd: string }): TestHost {
	const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "wt-host-"));
	process.env.OMP_WORKER_STATE_DIR = stateDir;

	const host: TestHost = {
		tools: new Map(),
		handlers: [],
		delivered: [],
		labels: [],
		stateDir,
		panes: new Set(),
		async fire(event, ctx) {
			for (const entry of host.handlers) {
				if (entry.event === event) await entry.handler({}, ctx);
			}
		},
		async call(name, args) {
			const tool = host.tools.get(name);
			if (!tool) throw new Error(`The extension did not register the tool ${name}`);
			const result = await tool.execute("test", args, undefined, undefined, { cwd: options.cwd });
			// Remember every pane the extension created, so the cleanup can
			// close it. A worker process holds its directory open.
			if (name === "wezterm_spawn_worker" || name === "wezterm_worker_resume") {
				const paneId = detailNumber(result.details, "paneId");
				if (paneId !== null) host.panes.add(paneId);
			}
			return result;
		},
		text(result) {
			return result.content.map((c) => c.text).join("\n");
		},
		cleanup() {
			// A worker process holds its working directory open. Close its pane
			// first and wait for the pane to go, so the process can let go of
			// the directory.
			const panes = [...host.panes];
			host.panes.clear();
			return closePanesAndWait(panes).then(() => {
				removeDir(stateDir);
			});
		},
	};

	const pi = {
		registerTool(def: ToolDef) {
			host.tools.set(def.name, def);
		},
		registerCommand() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
			host.handlers.push({ event, handler });
		},
		setLabel(label: string) {
			host.labels.push(label);
		},
		logger: {
			info() {},
			warn() {},
			error(message: string) {
				console.error("[extension]", message);
			},
		},
		sendUserMessage(text: string) {
			host.delivered.push(text);
		},
		sendMessage(text: string) {
			host.delivered.push(text);
		},
		zod: {
			string: () => schema(),
			number: () => schema(),
			boolean: () => schema(),
			array: () => schema(),
			object: () => schema(),
		},
	};

	extension(pi as never);
	return host;
}

/** The event context the host passes to a `session_start` handler. */
export function sessionContext(cwd: string): unknown {
	return {
		cwd,
		setInterval(fn: () => void, ms: number) {
			const handle = setInterval(fn, ms);
			handle.unref?.();
			return handle;
		},
		clearTimer(handle: NodeJS.Timeout) {
			clearInterval(handle);
		},
	};
}

/**
 * Read a string field from the details of a tool result.
 *
 * The details are `unknown`, because the tool decides the shape. This reads
 * one field and checks it at runtime, so a wrong shape fails in the test
 * instead of failing silently.
 */
export function detailString(details: unknown, field: string): string | null {
	if (details === null || typeof details !== "object") return null;
	const record = details as Record<string, unknown>;
	if (!(field in record)) return null;
	const value = record[field];
	return typeof value === "string" ? value : null;
}

/** Read a number field from the details of a tool result. */
export function detailNumber(details: unknown, field: string): number | null {
	if (details === null || typeof details !== "object") return null;
	const record = details as Record<string, unknown>;
	if (!(field in record)) return null;
	const value = record[field];
	return typeof value === "number" ? value : null;
}

/** Read a boolean field from the details of a tool result. */
export function detailBoolean(details: unknown, field: string): boolean | null {
	if (details === null || typeof details !== "object") return null;
	const record = details as Record<string, unknown>;
	if (!(field in record)) return null;
	const value = record[field];
	return typeof value === "boolean" ? value : null;
}

/** One message from a worker transcript. */
export interface TranscriptMessage {
	role: "user" | "assistant" | "toolResult";
	text: string;
	toolCalls: string[];
}

/**
 * Read the messages of a worker's transcript in order.
 *
 * The transcript is the worker's record, so it is the evidence for what the
 * worker did and when.
 */
export function readTranscript(sessionDir: string): TranscriptMessage[] {
	const files = listSessionFiles(sessionDir);
	if (files.length === 0) return [];
	const messages: TranscriptMessage[] = [];
	for (const line of readFileSync(files[0], "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: {
			type?: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string; name?: string }> };
		};
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
		messages.push({
			role,
			text: blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
			toolCalls: blocks.filter((b) => b.type === "toolCall").map((b) => b.name ?? "?"),
		});
	}
	return messages;
}

/**
 * The answer a worker gave after its last user message.
 *
 * A steering message arrives as a user message. The answer that follows it
 * is the answer to that message.
 */
export function answerAfterLastUser(messages: TranscriptMessage[]): string | null {
	let index = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			index = i;
			break;
		}
	}
	if (index < 0) return null;
	for (let i = index + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant" && message.text && message.toolCalls.length === 0) {
			return message.text;
		}
	}
	return null;
}

/** Wait for a condition. Returns false when the condition never holds. */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 30_000,
	stepMs = 250,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return await condition();
}

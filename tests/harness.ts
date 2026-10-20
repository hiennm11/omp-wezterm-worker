/**
 * A test host for the extension.
 *
 * The extension registers its tools with the host. The host records them, so
 * a test can call a tool the same way the agent calls it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	/** Run every handler for one event. */
	fire(event: string, ctx: unknown): Promise<void>;
	/** Call a tool by name. */
	call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
	/** The text of a tool result. */
	text(result: ToolResult): string;
	/** Remove the state directory. */
	cleanup(): void;
}

/** A schema object that accepts anything. The host validates the arguments. */
function schema(): Record<string, unknown> {
	const self: Record<string, unknown> = {};
	self.optional = () => self;
	self.describe = () => self;
	return self;
}

/**
 * Build a host with the extension loaded.
 *
 * `stateDir` holds the registry and the transcripts. The caller must set
 * `OMP_WORKER_STATE_DIR` before the extension reads its config, so the
 * environment is set here.
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
		async fire(event, ctx) {
			for (const entry of host.handlers) {
				if (entry.event === event) await entry.handler({}, ctx);
			}
		},
		async call(name, args) {
			const tool = host.tools.get(name);
			if (!tool) throw new Error(`The extension did not register the tool ${name}`);
			return await tool.execute("test", args, undefined, undefined, { cwd: options.cwd });
		},
		text(result) {
			return result.content.map((c) => c.text).join("\n");
		},
		cleanup() {
			rmSync(stateDir, { recursive: true, force: true });
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

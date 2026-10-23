/**
 * A test host for the extension.
 *
 * The extension registers its tools with the host. The host records them, so
 * a test can call a tool the same way the agent calls it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { answerAfterLastUser, readTranscript, type TranscriptMessage } from "./transcript-helpers.ts";

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
		ctx: { cwd: string; sessionManager?: { getSessionId: () => string | undefined } },
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
	/** The names of the slash commands that the extension registered. */
	commands: string[];
	stateDir: string;
	/** The panes that this host created. */
	panes: Set<number>;
	/** The ids of the workers that this host started or resumed. */
	workers: Set<string>;
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

/**
 * True while a worker process of the given directories still runs.
 *
 * A worker process holds its working directory open. The test waits for the
 * process to end, so the directory can be removed on Windows.
 *
 * The check looks at the whole process table. A worker of another test that
 * never ended must not keep this test waiting, so the check names the
 * directories of this test.
 */
export function workerProcessesRunning(directories: Iterable<string> = []): boolean {
	const dirs = [...directories];
	if (dirs.length === 0) return false;
	try {
		const patterns = dirs.map((d) => `'-${d.replace(/'/g, "''")}'`);
		const script =
			"$dirs = @(" +
			patterns.join(",") +
			"); (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--session-dir*' -and " +
			"($dirs | Where-Object { $_.CommandLine -like ('*' + $_ + '*') } | Select-Object -First 1) }).Count";
		const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
		});
		return Number.parseInt(out.trim(), 10) > 0;
	} catch {
		// A process table that cannot be read means unknown, not running.
		return false;
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
export function createHost(options: { stateDir?: string; cwd: string; sessionId?: string }): TestHost {
	const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "wt-host-"));
	process.env.OMP_WORKER_STATE_DIR = stateDir;

	const host: TestHost = {
		tools: new Map(),
		handlers: [],
		delivered: [],
		labels: [],
		commands: [],
		stateDir,
		panes: new Set(),
		workers: new Set(),
		async fire(event, ctx) {
			for (const entry of host.handlers) {
				if (entry.event === event) await entry.handler({}, ctx);
			}
		},
		async call(name, args) {
			const tool = host.tools.get(name);
			if (!tool) throw new Error(`The extension did not register the tool ${name}`);
			const sessionManager = options.sessionId ? { getSessionId: () => options.sessionId } : undefined;
			const result = await tool.execute("test", args, undefined, undefined, {
				cwd: options.cwd,
				sessionManager,
			});
			// Remember every pane the extension created, so the cleanup can
			// close it. A worker process holds its directory open.
			if (name === "wezterm_spawn_worker" || name === "wezterm_worker_resume") {
				const paneId = detailNumber(result.details, "paneId");
				if (paneId !== null) host.panes.add(paneId);
				const workerId = detailString(result.details, "workerId");
				if (workerId !== null) host.workers.add(workerId);
			}
			return result;
		},
		text(result) {
			return result.content.map((c) => c.text).join("\n");
		},
		async cleanup() {
			// The extension runtime is shared by every host in one test file.
			// Cancel each worker first, so a running job does not block the
			// next spawn through maxActiveWorkers. A finished worker answers
			// with an error, which does not matter here.
			const workers = [...host.workers];
			host.workers.clear();
			for (const workerId of workers) {
				await host.call("wezterm_worker_cancel", { workerId });
			}
			// A worker process holds its working directory open. Close its pane
			// first and wait for the pane to go, so the process can let go of
			// the directory.
			const panes = [...host.panes];
			host.panes.clear();
			await closePanesAndWait(panes);
			// The worker process needs a moment to end after its pane closed.
			// The wait names the session directory of this test, so a worker of
			// another test cannot hold this test up.
			await waitFor(() => !workerProcessesRunning([join(stateDir, "sessions")]), 30_000, 250);
			// The shutdown handler closes the database handle. Windows cannot
			// remove a file that a process holds open.
			await host.fire("session_shutdown", sessionContext(options.cwd));
			removeDir(stateDir);
		},
	};

	const pi = {
		registerTool(def: ToolDef) {
			host.tools.set(def.name, def);
		},
		registerCommand(name: string) {
			host.commands.push(name);
		},
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
export function sessionContext(cwd: string, sessionId?: string): unknown {
	return {
		cwd,
		sessionManager: sessionId ? { getSessionId: () => sessionId } : undefined,
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

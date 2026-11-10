/**
 * Herdr panes.
 *
 * Every function here touches only the pane ids it is given. No function
 * lists panes to act on them, so a pane that belongs to the user is never
 * touched.
 *
 * The pane id is a string such as `w4:p1`. Herdr names the panes, and the
 * extension never builds an id.
 */

import { backendLabel, readBackend } from "./backend.ts";
import { LAYOUT_APPLY_VERB } from "./herdr-layout.ts";
import type { Job } from "./job.ts";
import { delay, describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

export type PaneState = "present" | "gone" | "unknown";

/**
 * The pane ids of a pane list, or null when the list cannot be read.
 *
 * The reply of Herdr holds the panes under `result.panes`. Every pane has
 * the id `pane_id`.
 */
function parsePaneIds(stdout: string): Set<string> | null {
	const reply = parseJson(stdout);
	if (reply === null) return null;
	const result = memberOf(reply, "result");
	if (result === null) return null;
	const panes = memberOf(result, "panes");
	if (!Array.isArray(panes)) return null;
	const ids = new Set<string>();
	for (const entry of panes) {
		if (typeof entry !== "object" || entry === null) continue;
		const paneId = memberOf(entry, "pane_id");
		if (typeof paneId !== "string") continue;
		ids.add(paneId);
	}
	return ids;
}

/** The parsed JSON of a reply, or null when the reply is not JSON. */
function parseJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

/**
 * A member of a parsed reply, or null when it is not there.
 *
 * The reply of Herdr comes from a program, so the shape is unknown. The
 * function narrows the value instead of trusting it.
 */
function memberOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return null;
	if (!(key in value)) return null;
	return (value as Record<string, unknown>)[key];
}

/** An unreadable pane list is "unknown", never "gone": a broken CLI must not look like a closed pane. */
export async function paneState(rt: WorkerRuntime, paneId: string): Promise<PaneState> {
	const listing = await rt.herdr(["pane", "list"]);
	if (listing.code !== 0) return "unknown";
	const ids = parsePaneIds(listing.stdout);
	if (ids === null) return "unknown";
	return ids.has(paneId) ? "present" : "gone";
}

/**
 * The state of every given pane id.
 *
 * The function reads the pane list one time, whatever the number of ids. It
 * returns one entry for every id that it received. An unreadable list makes
 * every entry "unknown", because a broken CLI must not look like a closed
 * pane.
 */
export async function paneStatesOf(
	rt: WorkerRuntime,
	paneIds: readonly string[],
): Promise<Map<string, PaneState>> {
	const states = new Map<string, PaneState>();
	if (paneIds.length === 0) return states;
	const listing = await rt.herdr(["pane", "list"]);
	const ids = listing.code === 0 ? parsePaneIds(listing.stdout) : null;
	for (const paneId of paneIds) {
		if (ids === null) states.set(paneId, "unknown");
		else states.set(paneId, ids.has(paneId) ? "present" : "gone");
	}
	return states;
}

/**
 * Start the worker process in a new pane.
 *
 * Every value in `ompArgs` is its own argv element, so the task is never
 * parsed by a shell and quoting cannot go wrong.
 *
 * On success the job holds its pane id and is `running`. Returns the reason
 * when the pane could not start, and leaves the job alone.
 */
export async function launchPane(
	rt: WorkerRuntime,
	job: Job,
	ompArgs: string[],
	env?: NodeJS.ProcessEnv,
): Promise<string | null> {
	return launchProgram(rt, job, "omp", ompArgs, env);
}

/**
 * Start a program in a new pane.
 *
 * The program is the binary that the backend selected. An OMP worker starts
 * the omp binary, and a native worker starts the binary of its CLI.
 */
export async function launchProgram(
	rt: WorkerRuntime,
	job: Job,
	binary: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<string | null> {
	const opened = await openPane(rt, job, env);
	if ("failure" in opened) return `Herdr did not open a pane for this worker: ${opened.failure}`;
	const paneId = opened.paneId;
	const started = await startAgent(rt, paneId, job, binary, args);
	if (started !== null) return started;
	job.paneId = paneId;
	job.tabId = opened.tabId;
	job.windowId = null;
	job.status = "running";
	job.startedAt = Date.now();
	job.paneClosed = false;

	// Name the tab so the user can find the worker in the tab bar. Only a
	// worker that got its own tab may rename that tab: with a split the pane
	// shares the user's tab, and renaming it would overwrite the title of
	// whatever the user is running.
	if (job.placement === "tab") {
		const title = `${backendLabel(readBackend(job))} worker ${job.id}`;
		await rt.herdr(["tab", "rename", opened.tabId, title]);
	}
	return null;
}

/**
 * The pane that a launch opened, with its tab.
 *
 * A split opens a pane next to the pane of the main session. A tab opens a
 * pane in a tab of its own. The function returns null when Herdr refused.
 */
async function openPane(
	rt: WorkerRuntime,
	job: Job,
	env?: NodeJS.ProcessEnv,
): Promise<{ paneId: string; tabId: string } | { failure: string }> {
	const args =
		job.placement === "tab"
			? ["tab", "create", "--cwd", job.cwd, "--label", backendLabel(readBackend(job)), "--no-focus"]
			: ["pane", "split", "--current", "--direction", "right", "--cwd", job.cwd, "--no-focus"];
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) continue;
			args.push("--env", `${key}=${value}`);
		}
	}
	const res = await rt.herdr(args);
	if (res.code !== 0) return { failure: describeFailure(res) };
	const pane = paneOfReply(res.stdout);
	if (pane === null) return { failure: "the reply of Herdr holds no pane id" };
	return pane;
}

/**
 * Open a tab with one pane that runs a program.
 *
 * Herdr 0.9.5 has no `layout` command in its CLI, so the call goes through
 * the socket API. The call never names a `tab_id`, so the tab of the main
 * session survives.
 */
export async function openProgramTab(
	rt: WorkerRuntime,
	options: {
		cwd: string;
		command: string[];
		env?: NodeJS.ProcessEnv;
		label?: string;
	},
): Promise<{ paneId: string; tabId: string } | null> {
	const leaf: Record<string, unknown> = {
		type: "pane",
		cwd: options.cwd,
		command: options.command,
	};
	if (options.env) {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.env)) {
			if (value === undefined) continue;
			env[key] = value;
		}
		if (Object.keys(env).length > 0) leaf.env = env;
	}
	const params: Record<string, unknown> = { root: leaf, focus: false };
	if (options.label) params.tab_label = options.label;
	const res = await rt.herdr([LAYOUT_APPLY_VERB, JSON.stringify(params)]);
	if (res.code !== 0) return null;
	return paneOfReply(res.stdout);
}

/**
 * The pane and the tab of a reply of Herdr.
 *
 * A tab creation holds the pane under `result.root_pane`. A split holds it
 * under `result.pane`. The function returns null when the reply holds no
 * pane id.
 */
function paneOfReply(stdout: string): { paneId: string; tabId: string } | null {
	const reply = parseJson(stdout);
	if (reply === null) return null;
	const result = memberOf(reply, "result");
	if (result === null) return null;
	const pane = memberOf(result, "root_pane") ?? memberOf(result, "pane");
	if (typeof pane !== "object" || pane === null) return null;
	const paneId = memberOf(pane, "pane_id");
	if (typeof paneId !== "string") return null;
	const tabId = memberOf(pane, "tab_id");
	return { paneId, tabId: typeof tabId === "string" ? tabId : "" };
}

/**
 * Start the worker program in a pane that Herdr opened.
 *
 * Herdr starts the program of the kind and passes the arguments after `--`
 * to it. Every argument stays one argv element, so a task with spaces,
 * quotes and `$(...)` keeps its shape.
 */
async function startAgent(
	rt: WorkerRuntime,
	paneId: string,
	job: Job,
	binary: string,
	args: string[],
): Promise<string | null> {
	const kind = agentKindOf(binary);
	if (kind === null) return `Herdr cannot start the program '${binary}' as an agent.`;
	const res = await rt.herdr([
		"agent",
		"start",
		job.id,
		"--kind",
		kind,
		"--pane",
		paneId,
		"--",
		...args,
	]);
	if (res.code === 0) return null;
	return `Herdr did not start the worker in pane ${paneId}: ${describeFailure(res)}`;
}

/**
 * The kind of Herdr that runs a binary, or null when Herdr has no such kind.
 *
 * Herdr picks the program of the kind from the PATH. The key of the binary
 * of the configuration changes the check of the program, not the program that
 * Herdr starts.
 */
export function agentKindOf(binary: string): "omp" | "claude" | "codex" | null {
	const name = binary.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
	if (name.startsWith("omp")) return "omp";
	if (name.startsWith("claude")) return "claude";
	if (name.startsWith("codex")) return "codex";
	return null;
}

/**
 * Send text into a running worker's composer and submit it.
 *
 * `agent prompt` sends the text and the Enter key in one call. The worker
 * takes the text as one instruction.
 */
export async function sendToPane(
	rt: WorkerRuntime,
	paneId: string,
	text: string,
): Promise<{ ok: boolean; error: string | null }> {
	const res = await rt.herdr(["agent", "prompt", paneId, text]);
	if (res.code !== 0) return { ok: false, error: describeFailure(res) };
	return { ok: true, error: null };
}

/**
 * Read the last few visible lines of a pane.
 *
 * This is a debug aid for a stalled worker, never a result source: the
 * worker's transcript stays the only authority on what the worker produced.
 */
export async function paneTail(rt: WorkerRuntime, paneId: string, lines: number): Promise<string> {
	const res = await rt.herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
	if (res.code !== 0) return "";
	const rows = res.stdout.split("\n").filter((l) => l.trim());
	return rows.slice(-lines).join("\n");
}

/** Ask Herdr to close one pane. Returns the failure reason, or null when the request was accepted. */
export async function killPane(rt: WorkerRuntime, paneId: string): Promise<string | null> {
	const res = await rt.herdr(["pane", "close", paneId]);
	return res.code === 0 ? null : describeFailure(res);
}

/** Close one pane and wait until the pane list shows it is gone. Returns null when confirmed, else the reason. */
export async function closePaneConfirmed(rt: WorkerRuntime, paneId: string): Promise<string | null> {
	// A failed kill still polls: "pane not found" means the pane is already gone.
	const killFailure = await killPane(rt, paneId);
	const { attempts, intervalMs } = rt.stopConfirm;
	let last: PaneState = "present";
	for (let attempt = 0; attempt < attempts; attempt++) {
		last = await paneState(rt, paneId);
		if (last === "gone") return null;
		if (attempt < attempts - 1) await delay(intervalMs);
	}
	if (killFailure !== null) return `Herdr refused to close pane ${paneId}: ${killFailure}`;
	if (last === "unknown")
		return `The Herdr pane list cannot be read, so the close of pane ${paneId} is not confirmed.`;
	return `Pane ${paneId} is still open after the close request.`;
}

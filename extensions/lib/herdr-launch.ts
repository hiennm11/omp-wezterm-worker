/**
 * The launch of a worker in a Herdr pane.
 *
 * The launch opens a pane next to the pane of the main session, or in a tab
 * of its own. It starts the program as an agent and sends the task with the
 * agent prompt. Every function touches only the pane that this launch
 * opened, so a pane of the user is never touched.
 */

import { backendLabel, readBackend } from "./backend.ts";
import { LAYOUT_APPLY_VERB } from "./herdr-layout.ts";
import type { Job } from "./job.ts";
import { killPane, sendToPane } from "./pane.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Start the worker process in a new pane.
 *
 * Every value in `ompArgs` is its own argv element, so the task is never
 * parsed by a shell and quoting cannot go wrong. The task is not an argv
 * element: Herdr refuses an argument with a line break, and a real task has
 * line breaks. The task goes to the worker through the agent prompt after
 * the worker is ready.
 *
 * On success the job holds its pane id and is `running`. Returns the reason
 * when the pane could not start, and leaves the job alone.
 */
export async function launchPane(
	rt: WorkerRuntime,
	job: Job,
	ompArgs: string[],
	env?: NodeJS.ProcessEnv,
	task?: string,
): Promise<string | null> {
	return launchProgram(rt, job, "omp", ompArgs, env, task);
}

/**
 * Start a program in a new pane.
 *
 * The program is the binary that the backend selected. An OMP worker starts
 * the omp binary, and a native worker starts the binary of its CLI.
 *
 * A launch that fails after the pane opened closes that pane. Only the pane
 * that this launch opened is closed, so a pane of the user is never touched.
 */
export async function launchProgram(
	rt: WorkerRuntime,
	job: Job,
	binary: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
	task?: string,
): Promise<string | null> {
	const argRefusal = argvRefusal(args);
	if (argRefusal) return argRefusal;
	const opened = await openPane(rt, job, env);
	if ("failure" in opened) return `Herdr did not open a pane for this worker: ${opened.failure}`;
	const paneId = opened.paneId;
	const started = await startAgent(rt, paneId, job, binary, args);
	if (started !== null) {
		await killPane(rt, paneId);
		return started;
	}
	if (task) {
		const sent = await sendToPane(rt, paneId, task);
		if (!sent.ok) {
			await killPane(rt, paneId);
			return `Herdr did not deliver the task to the worker in pane ${paneId}: ${sent.error}`;
		}
	}
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
 * The reason that Herdr cannot take an argv, or null when it can.
 *
 * Herdr refuses an argument with a line break, a carriage return or a tab,
 * because it cannot encode such an argument for the shell of the pane. The
 * check runs before a pane opens, so a refused launch leaves no pane behind.
 */
export function argvRefusal(args: readonly string[]): string | null {
	for (const arg of args) {
		if (/[\r\n\t]/.test(arg)) {
			return "Herdr cannot take an argument with a line break or a tab. Send the text with the agent prompt.";
		}
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
	let reply: unknown;
	try {
		reply = JSON.parse(stdout);
	} catch {
		return null;
	}
	const result = memberOf(reply, "result");
	if (result === null) return null;
	const pane = memberOf(result, "root_pane") ?? memberOf(result, "pane");
	if (typeof pane !== "object" || pane === null) return null;
	const paneId = memberOf(pane, "pane_id");
	if (typeof paneId !== "string") return null;
	const tabId = memberOf(pane, "tab_id");
	return { paneId, tabId: typeof tabId === "string" ? tabId : "" };
}

/** A member of a parsed reply, or null when it is not there. */
function memberOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return null;
	if (!(key in value)) return null;
	return (value as Record<string, unknown>)[key] ?? null;
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
	const res = await rt.herdr(["agent", "start", job.id, "--kind", kind, "--pane", paneId, "--", ...args]);
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
export function agentKindOf(binary: string): "omp" | "claude" | null {
	const name = binary.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
	if (name.startsWith("omp")) return "omp";
	if (name.startsWith("claude")) return "claude";
	return null;
}

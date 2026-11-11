/**
 * The Claude Code session of a worker.
 *
 * A Claude worker runs a real interactive Claude Code session in a pane. The
 * session loads a session-scoped mod. The mod carries the report tool and
 * the command bridge.
 *
 * The pane calls go through the runtime of the job. The session therefore
 * runs on Herdr and on WezTerm.
 *
 * The launch never changes a global setting of the user. The session keeps
 * the configuration, the credentials, the MCP servers and the permission
 * rules that the user already set. A model that the user names is passed
 * through unchanged. An omitted model uses the default of Claude Code.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Job } from "./job.ts";
import { paneTail, sendEnter, sendToPane } from "./pane.ts";
import { delay, describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The name of the session-scoped mod directory of the package. */
export const CLAUDE_MOD_DIR = join(import.meta.dirname, "..", "claude-mod");

/** The id of a native Claude session. */
export type ClaudeSessionId = string;

/** How often the follow-up send is tried. */
const MAX_FOLLOW_UP_ATTEMPTS = 20;

/** The wait between two attempts of the follow-up send. */
const COMPOSER_POLL_MS = 500;

/** How long the extension waits for the composer of a session. */
const COMPOSER_TIMEOUT_MS = 60_000;

/** The wait that lets a composer settle before the Enter arrives. */
const COMPOSER_SETTLE_MS = 1500;

/**
 * The plugin directory of one worker session.
 *
 * The copy lives in the session directory of the worker, so two workers never
 * share one plugin directory. The interactive load writes the build-specific
 * types into the copy.
 */
export function preparePlugin(sessionDir: string): string {
	const target = join(sessionDir, "claude-plugin");
	mkdirSync(target, { recursive: true });
	cpSync(CLAUDE_MOD_DIR, target, { recursive: true });
	return target;
}

/**
 * The plugin directory of a session, or null when the session has none.
 */
export function pluginOf(sessionDir: string): string | null {
	const target = join(sessionDir, "claude-plugin");
	return existsSync(join(target, ".claude-plugin", "plugin.json")) ? target : null;
}

/** The Claude argv of one session. Every value is its own argv element. */
export function claudeArgv(options: {
	sessionId: string;
	pluginDir: string;
	contractFile: string;
	model: string | null;
	cwd: string;
	task: string;
}): string[] {
	/* The contract travels in a file. The text has many lines, and Herdr
	   refuses an argument with a line break. The path has no line break, so it
	   reaches the program of the pane. */
	const args = [
		"--session-id",
		options.sessionId,
		"--plugin-dir",
		options.pluginDir,
		"--append-system-prompt-file",
		options.contractFile,
	];
	/* An omitted model keeps the default of Claude Code. The extension never
	   adds a model that the user did not name. */
	if (options.model) args.push("--model", options.model);
	if (options.task) args.push(options.task);
	return args;
}

/**
 * The Claude argv of a resumed session.
 *
 * The CLI continues a session with `--resume <id>`. The flag `--session-id`
 * creates a new session, and the CLI refuses it when the id already exists.
 */
export function claudeResumeArgv(options: {
	sessionId: string;
	pluginDir: string;
	contractFile: string;
	model: string | null;
}): string[] {
	const args = [
		"--resume",
		options.sessionId,
		"--plugin-dir",
		options.pluginDir,
		"--append-system-prompt-file",
		options.contractFile,
	];
	if (options.model) args.push("--model", options.model);
	return args;
}

/**
 * The reason that the Claude binary cannot run, or null when it can.
 */
export async function checkClaude(rt: WorkerRuntime, bin: string): Promise<string | null> {
	const check = await rt.exec(bin, ["--version"]);
	if (check.code !== 0) {
		return `Cannot run the Claude Code binary '${bin}': ${describeFailure(check)}`;
	}
	return null;
}

/** The reason Claude Code refuses the session-scoped mod, or null when it accepts it. */
export async function validatePlugin(
	rt: WorkerRuntime,
	bin: string,
	pluginDir: string,
): Promise<string | null> {
	try {
		const result = await rt.exec(bin, ["plugin", "validate", pluginDir]);
		if (result.code === 0) return null;
		return `The installed Claude Code refused the mod of the extension: ${describeFailure(result)}`;
	} catch (error) {
		return `The mod of the extension could not be checked: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Send a follow-up instruction into the composer of a resumed session.
 *
 * A resumed Claude session keeps its history, and it does not take a new
 * prompt as an argument. The instruction therefore goes into the composer of
 * the pane, the way the user types it.
 *
 * The keystrokes reach the pane before the interface of the session exists,
 * and then they go nowhere. The function waits for the composer first, and
 * it repeats the send when the composer still holds no text.
 *
 * The pane calls go through the runtime of the job. A WezTerm pane shows its
 * composer in the same text, so the rule that the pane text is a diagnostic
 * view stays true.
 */
export async function typeFollowUp(rt: WorkerRuntime, job: Job, message: string): Promise<string | null> {
	let last = "";
	for (let attempt = 1; attempt <= MAX_FOLLOW_UP_ATTEMPTS; attempt += 1) {
		const text = await paneTail(rt, job, 200);
		last = text;
		if (composerReady(text)) {
			/* A native composer that still loads its history drops an
			   Enter. The text and the Enter go in two steps, and the
			   composer settles before the Enter arrives. */
			await delay(COMPOSER_SETTLE_MS);
			const typed = await sendToPane(rt, job, message);
			if (!typed.ok) return typed.error;
			await delay(COMPOSER_POLL_MS);
			const entered = await sendEnter(rt, job);
			if (entered !== null) return entered;
			/* The pane text is a diagnostic view. It never proves that the
			   session took the instruction, because a submitted instruction
			   stays visible in the history. The report of the worker proves
			   it. */
			return null;
		}
		await delay(COMPOSER_POLL_MS);
	}
	return `The session of the worker did not reach its composer. The pane showed: ${last.slice(-200)}`;
}

/**
 * Wait until the composer of a session accepts an instruction.
 *
 * A session that still starts shows no permission row. The person answers
 * the startup questions of a session in the pane, so the extension waits
 * for the composer instead of answering them.
 */
export async function waitForComposer(
	rt: WorkerRuntime,
	job: Job,
	deadlineMs = COMPOSER_TIMEOUT_MS,
): Promise<boolean> {
	if (job.paneId === null) return false;
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (composerReady(await paneTail(rt, job, 200))) return true;
		await delay(COMPOSER_POLL_MS);
	}
	return false;
}

/**
 * The reason that the composer of a session is not ready, or null when it is.
 *
 * A session shows its prompt when it is ready for an instruction. The pane
 * text is a diagnostic view, and the function only uses it to wait.
 */
function composerReady(text: string): boolean {
	/* The interface draws its permission row only when the session is live
	   and the composer accepts an instruction. A session that is still
	   starting shows no such row. */
	if (text.includes("bypass permissions on")) return true;
	if (text.includes("shift+tab to")) return true;
	return false;
}

/**
 * The directories that hold the session files of a Claude session.
 *
 * Claude Code keeps its own history under the home directory of the user.
 * The extension never writes there. The function only reads the names, so a
 * resume can find the session that it needs.
 */
export function claudeSessionDirs(home: string): string[] {
	const root = join(home, ".claude", "projects");
	try {
		return readdirSync(root);
	} catch {
		return [];
	}
}

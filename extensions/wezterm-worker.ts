/**
 * wezterm-worker — spawn an OMP worker session inside a WezTerm pane or tab and
 * let the user watch it live while the main agent keeps working.
 *
 * Verified against omp 18.12.3 on Windows native.
 *
 * Mechanism boundary (three distinct things, deliberately not conflated):
 *
 *  - native subagent : the `task` tool. In-process child session, no pane,
 *                       visible in the Agent Hub. Managed and result-delivered
 *                       by OMP core.
 *  - this worker     : a SEPARATE `omp` PROCESS running in a WezTerm pane, with
 *                       its own model, tools and session file. It does not
 *                       inherit the main conversation.
 *  - pane transcript : `wezterm cli get-text` only reads rendered screen text.
 *                       It is a read-only view, never used as a result source.
 *
 * The worker result comes from the worker's own session JSONL, which is the
 * authoritative artifact — not from scraping pane text.
 *
 * Delivery: the finished result is pushed back into the main session with
 * `pi.sendUserMessage(text, { triggerTurn: true })`, so the main agent sees
 * it without the user having to read a file. `pi.sendMessage` with
 * `deliverAs: "steer"` is the fallback for a host without `sendUserMessage`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { DEFAULT_CONFIG, loadConfig, type Placement, type WorkerConfig } from "./lib/config.ts";
import type { Job, JobStatus } from "./lib/job.ts";
import {
	loadRegistry as loadRegistryFromDisk,
	persistRegistry as persistRegistryToDisk,
} from "./lib/registry.ts";
import { isTurnComplete, listSessionFiles, summarizeSession } from "./lib/transcript.ts";

// ---------------------------------------------------------------------------
// Job registry (module scope: shared by every session this factory binds)
// ---------------------------------------------------------------------------

const JOBS = new Map<string, Job>();
const MONITORS = new Map<string, NodeJS.Timeout>();
let JOB_SEQ = 0;

/**
 * Errors raised inside a background poll.
 *
 * A poll that throws must not take the session down, so the failure is
 * recorded here and surfaced through the extension logger.
 */
const EXTENSION_ERRORS: string[] = [];

/**
 * Managed timers.
 *
 * OMP runs extensions in-process with no isolation: a raw `setInterval`
 * callback that throws becomes a process-level `uncaughtException` and tears
 * the whole session down. Every background poll therefore goes through the
 * host's `ctx.setInterval`, which contains the failure, and every callback
 * carries its own try/catch as a second line of defence.
 */
interface TimerHost {
	setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
}

let TIMER_HOST: TimerHost = {
	setInterval: (fn, ms) => {
		const timer = setInterval(fn, ms);
		timer.unref?.();
		return timer;
	},
};

/** Replace the timer host with the host's managed timers. */
function useTimerHost(host: TimerHost): void {
	TIMER_HOST = host;
}

/**
 * Start a managed interval.
 *
 * The callback body is wrapped: a throw inside it is reported and the poller
 * keeps running instead of taking the session down.
 */
function startManagedInterval(fn: () => void, ms: number): NodeJS.Timeout {
	return TIMER_HOST.setInterval(() => {
		try {
			fn();
		} catch (e) {
			// A failed poll must never end the session.
			EXTENSION_ERRORS.push(e instanceof Error ? e.message : String(e));
		}
	}, ms);
}

/**
 * Effective configuration. Replaced on every factory bind so a session picks up
 * the current file/env values. Module scope is required: child sessions rebind
 * the factory but must observe the same job registry.
 */
let CONFIG: WorkerConfig = { ...DEFAULT_CONFIG };

/** Write the registry of this session to disk. */
function persistRegistry(): void {
	persistRegistryToDisk(CONFIG.stateDir, JOBS.values());
}

/** Read the registry of this session from disk. */
function readRegistry(): { finished: Job[]; alive: Job[] } {
	return loadRegistryFromDisk(CONFIG.stateDir);
}

function nextJobId(): string {
	JOB_SEQ += 1;
	return `wz-${Date.now().toString(36)}-${JOB_SEQ.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(bin: string, args: string[], cwd?: string): Promise<RunResult> {
	const { promise, resolve: settle } = Promise.withResolvers<RunResult>();
	const child = spawn(bin, args, {
		cwd,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (d: string) => (stdout += d));
	child.stderr.on("data", (d: string) => (stderr += d));
	child.on("error", (e: Error) => settle({ code: -1, stdout, stderr: stderr + String(e) }));
	child.on("close", (code: number | null) => settle({ code: code ?? -1, stdout, stderr }));
	return promise;
}

function wezterm(args: string[]): Promise<RunResult> {
	return run(CONFIG.weztermBin, ["cli", ...args]);
}

function git(cwd: string, args: string[]): Promise<RunResult> {
	return run("git", args, cwd);
}

// ---------------------------------------------------------------------------
// Git worktree isolation
// ---------------------------------------------------------------------------

async function createWorktree(cwd: string, jobId: string): Promise<{ path: string; branch: string }> {
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		throw new Error(`Isolation requested but cwd is not a git repository: ${cwd}`);
	}
	const base = join(CONFIG.stateDir, "worktrees", jobId);
	mkdirSync(join(CONFIG.stateDir, "worktrees"), { recursive: true });
	const branch = `omp/worker/${jobId}`;
	const res = await git(cwd, ["worktree", "add", "-b", branch, base, "HEAD"]);
	if (res.code !== 0) {
		throw new Error(`git worktree add failed: ${(res.stderr || res.stdout).trim()}`);
	}
	return { path: base, branch };
}

/**
 * Look at a worktree before it is removed.
 *
 * A worker may have committed nothing and still leave uncommitted edits,
 * untracked files or stashes behind. Those are the worker's output, so the
 * worktree is only safe to remove when the checkout is clean.
 */
async function inspectWorktree(path: string): Promise<{
	exists: boolean;
	clean: boolean;
	changes: string[];
}> {
	if (!existsSync(path)) return { exists: false, clean: true, changes: [] };
	const res = await git(path, ["status", "--porcelain"]);
	if (res.code !== 0) {
		// An unreadable status means the state is unknown, so it is not clean.
		return {
			exists: true,
			clean: false,
			changes: [(res.stderr || res.stdout || "git status failed").trim()],
		};
	}
	const changes = res.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	return { exists: true, clean: changes.length === 0, changes };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

interface SpawnParams {
	task: string;
	cwd?: string;
	label?: string;
	model?: string;
	tools?: string[];
	placement?: Placement;
	isolated?: boolean;
	/** Overrides the configured timeout for this worker. 0 means no timeout. */
	timeoutMs?: number;
	/** Close the worker pane when the worker finishes. Defaults to the config. */
	closePaneOnFinish?: boolean;
}

async function spawnWorker(params: SpawnParams): Promise<Job> {
	const jobId = nextJobId();
	const job: Job = {
		id: jobId,
		label: params.label || jobId,
		task: params.task,
		cwd: resolve(params.cwd || CONFIG.defaultCwd),
		model: params.model ?? CONFIG.model,
		tools: params.tools ?? CONFIG.tools,
		status: "queued",
		paneId: null,
		tabId: null,
		windowId: null,
		placement: params.placement || CONFIG.placement,
		sessionDir: join(CONFIG.stateDir, "sessions", jobId),
		sessionFile: null,
		createdAt: Date.now(),
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		worktreeDirty: null,
		cancelled: false,
		lastActivityAt: Date.now(),
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		steers: 0,
		lastTranscriptSize: 0,
		timeoutMs: params.timeoutMs ?? CONFIG.timeoutMs,
		idleTimeoutMs: CONFIG.idleTimeoutMs,
		closePaneOnFinish: params.closePaneOnFinish ?? CONFIG.closePaneOnFinish,
		paneClosed: false,
	};
	JOBS.set(jobId, job);
	persistRegistry();

	if (!existsSync(job.cwd)) {
		await finalizeJob(job, "failed", `cwd does not exist: ${job.cwd}`, null);
		return job;
	}

	// Pre-flight the omp binary. A worker that cannot start leaves an empty
	// pane and never writes a transcript, so failing here reports the real
	// cause instead of a generic startup timeout.
	const ompCheck = await run(CONFIG.ompBin, ["--version"]);
	if (ompCheck.code !== 0) {
		await finalizeJob(
			job,
			"failed",
			"Cannot run the omp binary '" +
				CONFIG.ompBin +
				"': " +
				(ompCheck.stderr || ompCheck.stdout || `exit code ${ompCheck.code}`).trim(),
			null,
		);
		return job;
	}

	mkdirSync(job.sessionDir, { recursive: true });

	// Optional git worktree isolation so parallel workers never share a checkout.
	if (params.isolated ?? CONFIG.isolated) {
		try {
			const wt = await createWorktree(job.cwd, jobId);
			job.worktreePath = wt.path;
			job.worktreeBranch = wt.branch;
			job.worktreeOrigin = job.cwd;
			job.cwd = wt.path;
		} catch (e) {
			await finalizeJob(job, "failed", e instanceof Error ? e.message : String(e), null);
			return job;
		}
	}

	// omp argv — every value is its own argv element.
	const ompArgs: string[] = ["--no-title", "--cwd", job.cwd, "--session-dir", job.sessionDir];
	if (job.model) ompArgs.push("--model", job.model);
	if (job.tools?.length) ompArgs.push("--tools", job.tools.join(","));
	// The task is a single argv element: no shell parsing, no quoting hazards.
	ompArgs.push(job.task);

	// wezterm argv — placement decides the CLI verb.
	const weztermArgs: string[] =
		job.placement === "tab"
			? ["spawn", "--cwd", job.cwd, "--", CONFIG.ompBin, ...ompArgs]
			: ["split-pane", "--right", "--cwd", job.cwd, "--", CONFIG.ompBin, ...ompArgs];

	const res = await wezterm(weztermArgs);
	if (res.code !== 0) {
		await finalizeJob(
			job,
			"failed",
			`wezterm ${job.placement} failed: ${(res.stderr || res.stdout).trim()}`,
			null,
		);
		return job;
	}

	const paneId = Number.parseInt(res.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
		await finalizeJob(
			job,
			"failed",
			`wezterm did not return a pane id (got: ${JSON.stringify(res.stdout)})`,
			null,
		);
		return job;
	}
	job.paneId = paneId;
	job.status = "running";
	job.startedAt = Date.now();
	job.paneClosed = false;

	// Record which tab/window the pane landed in, so the user can find it.
	const listing = await wezterm(["list", "--format", "json"]);
	if (listing.code === 0) {
		try {
			const panes = JSON.parse(listing.stdout) as Array<{
				pane_id: number;
				tab_id: number;
				window_id: number;
			}>;
			const found = panes.find((p) => p.pane_id === paneId);
			if (found) {
				job.tabId = found.tab_id;
				job.windowId = found.window_id;
			}
		} catch {
			/* tab metadata is best-effort */
		}
	}

	// Name the tab so the user can find the worker in the tab bar. Only a
	// worker that got its own tab may rename that tab: with a split the pane
	// shares the user's tab, and renaming it would overwrite the title of
	// whatever the user is running.
	if (job.placement === "tab") {
		await wezterm(["set-tab-title", "--pane-id", String(paneId), `OMP worker ${job.id}`]);
	}

	// Persist again now that the pane id is known. The first write happened
	// before the pane existed, so without this the registry would record a
	// running worker with no pane, and a restart could not re-attach to it.
	persistRegistry();

	// The isolated worktree stays. It is the worker's checkout and holds
	// whatever it produced; wezterm_worker_cleanup releases it later.

	return job;
}

/**
 * Reopen a finished worker from its transcript.
 *
 * `omp --resume <path>` continues the session file, so the worker comes back
 * with its full history: the previous task, the previous answers, and any
 * steering messages already sent. The new process writes into the same
 * session directory, so the monitor keeps reading the same transcript.
 *
 * This is the only way to continue a worker that already completed: a
 * finished worker has no live composer to type into, and steering requires a
 * running pane.
 */
async function resumeWorker(source: Job, params: { message?: string; placement?: Placement }): Promise<Job> {
	const jobId = nextJobId();
	const sessionFile = source.sessionFile;
	if (!sessionFile || !existsSync(sessionFile)) {
		const failed: Job = {
			...source,
			id: jobId,
			status: "failed",
			error: `The worker has no transcript to resume: ${source.sessionFile ?? "(none)"}`,
			finishedAt: Date.now(),
		};
		JOBS.set(jobId, failed);
		return failed;
	}

	const job: Job = {
		...source,
		id: jobId,
		label: `${source.label} (resumed)`,
		status: "queued",
		paneId: null,
		tabId: null,
		windowId: null,
		placement: params.placement ?? source.placement,
		createdAt: Date.now(),
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
		// The resumed worker works in the same checkout, so the dirty state of
		// the previous run says nothing about this one.
		worktreeDirty: null,
		cancelled: false,
		lastActivityAt: Date.now(),
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		steers: 0,
		lastTranscriptSize: 0,
		paneClosed: false,
	};
	JOBS.set(jobId, job);

	// The transcript already holds the earlier turns. Record how many, so the
	// monitor only reports completion once the worker has produced a turn
	// beyond that count. Without this the previous answer is delivered as the
	// new result before the worker has done any work.
	const existing = listSessionFiles(job.sessionDir);
	if (existing.length > 0) {
		try {
			const summary = summarizeSession(existing[0]);
			job.baselineTurns = summary.turns;
			job.turns = summary.turns;
			job.lastTranscriptSize = statSync(existing[0]).size;
		} catch {
			/* an unreadable transcript just means no baseline */
		}
	}
	persistRegistry();

	// omp argv — resume the session file in place. The task is not repeated:
	// the transcript already holds it.
	const ompArgs: string[] = [
		"--no-title",
		"--cwd",
		job.cwd,
		"--session-dir",
		job.sessionDir,
		"--resume",
		sessionFile,
	];
	if (job.model) ompArgs.push("--model", job.model);
	if (job.tools?.length) ompArgs.push("--tools", job.tools.join(","));
	// A follow-up message restarts the turn; without one the worker opens on
	// its transcript and waits.
	if (params.message) ompArgs.push(params.message);

	const weztermArgs: string[] =
		job.placement === "tab"
			? ["spawn", "--cwd", job.cwd, "--", CONFIG.ompBin, ...ompArgs]
			: ["split-pane", "--right", "--cwd", job.cwd, "--", CONFIG.ompBin, ...ompArgs];

	const res = await wezterm(weztermArgs);
	if (res.code !== 0) {
		job.status = "failed";
		job.error = `wezterm ${job.placement} failed: ${(res.stderr || res.stdout).trim()}`;
		job.finishedAt = Date.now();
		persistRegistry();
		return job;
	}
	const paneId = Number.parseInt(res.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
		job.status = "failed";
		job.error = `wezterm did not return a pane id (got: ${JSON.stringify(res.stdout)})`;
		job.finishedAt = Date.now();
		persistRegistry();
		return job;
	}
	job.paneId = paneId;
	job.status = "running";
	job.startedAt = Date.now();
	job.sessionFile = sessionFile;

	// Only a worker that owns its tab may rename it — see spawnWorker.
	if (job.placement === "tab") {
		await wezterm(["set-tab-title", "--pane-id", String(paneId), `OMP worker ${job.id}`]);
	}
	persistRegistry();
	return job;
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

function stopMonitor(jobId: string): void {
	const timer = MONITORS.get(jobId);
	if (timer) {
		clearInterval(timer);
		MONITORS.delete(jobId);
	}
}

/**
 * Close the worker's pane and record the final state.
 *
 * A finished worker leaves a pane behind, and a pane left behind accumulates
 * until the user closes them by hand. The pane is closed here so the terminal
 * returns to the state before the spawn.
 *
 * The pane is closed *after* the result is captured, because the transcript is
 * the result source and the worker process stops writing once its pane dies.
 *
 * The isolated worktree is never removed here. A worker that committed or
 * edited something owns that output, so the checkout survives the worker and
 * is released only by wezterm_worker_cleanup.
 */
async function finalizeJob(
	job: Job,
	status: JobStatus,
	error: string | null,
	result: string | null,
): Promise<void> {
	job.status = status;
	job.error = error;
	job.result = result;
	job.finishedAt = Date.now();
	stopMonitor(job.id);

	// Close the pane this worker created. Only this pane id — never a sweep
	// over the pane list, so panes belonging to the user are never touched.
	// The cancel path already closed it, hence the paneClosed guard.
	if (job.paneId !== null && job.closePaneOnFinish && !job.paneClosed) {
		await wezterm(["kill-pane", "--pane-id", String(job.paneId)]);
		job.paneClosed = true;
	}

	// The isolated worktree is deliberately kept. A finished worker may have
	// left commits, uncommitted edits or untracked files behind, and those are
	// the worker's output. Removing the checkout here would destroy them.
	// wezterm_worker_cleanup releases it, and only when the checkout is clean.
	//
	// The dirty state is recorded now, so the status tool can say whether the
	// kept worktree still holds something worth looking at.
	if (job.worktreePath) {
		const state = await inspectWorktree(job.worktreePath);
		job.worktreeDirty = state.exists ? !state.clean : null;
	}

	persistRegistry();
}

/**
 * Remove a worker's isolated worktree.
 *
 * The worker's pane keeps the directory open, so the removal only succeeds
 * after that pane is gone. Returns the removal outcome instead of throwing.
 *
 * The directory is never deleted behind git's back: when git refuses, the
 * worktree stays and the caller reports why. Removing the branch is a
 * separate decision and is never taken here.
 */
async function removeWorktree(
	cwd: string,
	path: string,
): Promise<{ removed: boolean; error: string | null }> {
	const res = await git(cwd, ["worktree", "remove", "--force", path]);
	if (res.code === 0) return { removed: true, error: null };
	return { removed: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` };
}

async function paneExists(paneId: number): Promise<boolean> {
	const listing = await wezterm(["list", "--format", "json"]);
	if (listing.code !== 0) return false;
	try {
		const panes = JSON.parse(listing.stdout) as Array<{ pane_id: number }>;
		return panes.some((p) => p.pane_id === paneId);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/**
 * Send text into a running worker's composer and submit it.
 *
 * `wezterm cli send-text` pastes by default, and a pasted block never submits
 * in the OMP TUI: the text lands in the composer but the Enter key does not
 * arrive, so the worker sits there waiting.
 *
 * `--no-paste` sends the bytes as individual key events instead of a
 * bracketed paste, so the trailing "\r" is delivered as a real Enter and the
 * composer submits. The "\r" is appended here, never by the caller.
 */
async function sendToPane(paneId: number, text: string): Promise<{ ok: boolean; error: string | null }> {
	const res = await wezterm(["send-text", "--no-paste", "--pane-id", String(paneId), `${text}\r`]);
	if (res.code !== 0) {
		return { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` };
	}
	return { ok: true, error: null };
}

/**
 * The number of user messages in a worker's transcript.
 *
 * The count is the evidence that a steering message arrived. The keystrokes
 * can reach the pane before the worker starts its TUI, and then they go
 * nowhere.
 */
function userMessageCount(sessionDir: string): number {
	const files = listSessionFiles(sessionDir);
	if (files.length === 0) return 0;
	return summarizeSession(files[0]).userMessages.length;
}

/**
 * Steer a worker and confirm that the message arrived.
 *
 * The keystrokes reach the pane as soon as the pane exists. The worker needs
 * a few seconds to start its TUI, and keystrokes that arrive before that go
 * nowhere. The tool must not report success in that case, so the transcript
 * is read after every attempt and the send is repeated until the message
 * shows up there.
 */
async function steerWorker(
	job: Job,
	message: string,
): Promise<{ ok: boolean; error: string | null; attempts: number }> {
	const before = userMessageCount(job.sessionDir);
	const maxAttempts = 8;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const sent = await sendToPane(job.paneId as number, message);
		if (!sent.ok) {
			return { ok: false, error: sent.error, attempts: attempt };
		}
		// Give the worker a moment to write the message into its transcript.
		for (let wait = 0; wait < 10; wait++) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (userMessageCount(job.sessionDir) > before) {
				return { ok: true, error: null, attempts: attempt };
			}
		}
	}
	return {
		ok: false,
		error:
			"The worker did not accept the message. Its pane may not have started its interface yet. " +
			"Try again in a few seconds.",
		attempts: maxAttempts,
	};
}

/**
 * Read the last few visible lines of a pane.
 *
 * This is a debug aid for a stalled worker, never a result source: the
 * worker's transcript stays the only authority on what the worker produced.
 */
async function paneTail(paneId: number, lines: number): Promise<string> {
	const res = await wezterm(["get-text", "--pane-id", String(paneId)]);
	if (res.code !== 0) return "";
	const rows = res.stdout.split("\n").filter((l) => l.trim());
	return rows.slice(-lines).join("\n");
}

/**
 * Poll the worker session file until its turn completes, then report back.
 * `notify` delivers the result into the main session.
 *
 * A worker that dies during startup (missing omp binary, bad --model, a crash
 * before the session file is written) never produces a session file. The pane
 * disappears in that case, so the monitor treats "pane gone and still no
 * session file" as a startup failure instead of waiting for the timeout.
 */
function monitorJob(job: Job, notify: (job: Job) => void): void {
	stopMonitor(job.id);
	const cap = job.timeoutMs;
	const idleCap = job.idleTimeoutMs;
	const startupGraceMs = 45_000;
	const timer = startManagedInterval(() => {
		if (job.status !== "running" && job.status !== "queued") {
			stopMonitor(job.id);
			return;
		}
		const elapsed = Date.now() - (job.startedAt ?? job.createdAt);
		if (cap > 0 && elapsed > cap) {
			void (async () => {
				await finalizeJob(job, "failed", `Worker timed out after ${Math.round(cap / 1000)}s`, null);
				notify(job);
			})();
			return;
		}
		// A worker that stops producing transcript activity is stuck. The idle
		// deadline is separate from the total deadline so a long task that keeps
		// making progress is never killed.
		if (idleCap > 0 && Date.now() - job.lastActivityAt > idleCap) {
			void (async () => {
				await finalizeJob(
					job,
					"failed",
					`Worker produced no activity for ${Math.round(idleCap / 1000)}s and was stopped`,
					null,
				);
				notify(job);
			})();
			return;
		}
		const files = listSessionFiles(job.sessionDir);
		if (files.length === 0) {
			// No transcript yet. If the pane is gone the worker process exited
			// during startup; wait out the grace period before declaring it.
			const paneId = job.paneId;
			if (elapsed < startupGraceMs || paneId === null) return;
			void (async () => {
				if (await paneExists(paneId)) return;
				if (listSessionFiles(job.sessionDir).length > 0) return;
				await finalizeJob(
					job,
					"failed",
					"Worker process exited before producing a transcript (check the pane for the startup error)",
					null,
				);
				notify(job);
			})();
			return;
		}
		const file = files[0];
		const previousFile = job.sessionFile;
		job.sessionFile = file;
		const summary = summarizeSession(file);
		job.currentTool = summary.currentTool;
		job.turns = summary.turns;
		// A new transcript file, or a change in its size, means the worker did
		// something. The mtime is the cheap signal; the size catches an append
		// that lands inside the same poll tick.
		if (previousFile !== file) {
			job.lastActivityAt = Date.now();
		} else {
			try {
				const size = statSync(file).size;
				if (size !== job.lastTranscriptSize) {
					job.lastActivityAt = Date.now();
					job.lastTranscriptSize = size;
				}
			} catch {
				// The transcript vanished mid-read; the next poll handles it.
			}
		}
		if (!isTurnComplete(summary)) return;
		// A resumed worker opens on a transcript that already holds a finished
		// turn. Only a turn beyond the baseline counts as this worker's own
		// result, otherwise the previous answer is delivered as the new one.
		if (summary.finalTextIndex <= job.baselineTurns) return;

		const finalText = summary.finalText ?? "";
		void (async () => {
			if (job.cancelled) {
				await finalizeJob(job, "cancelled", "Worker cancelled", finalText || null);
			} else {
				await finalizeJob(job, "completed", null, finalText);
			}
			notify(job);
		})();
	}, CONFIG.pollMs);
	MONITORS.set(job.id, timer);
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

async function cancelJob(job: Job): Promise<{ paneClosed: boolean; error: string | null }> {
	job.cancelled = true;
	// Kill only the pane this extension created. Never touch other panes.
	// The pane is closed here, so finalizeJob must not close it a second time.
	let paneClosed = false;
	let error: string | null = null;
	if (job.paneId !== null) {
		const res = await wezterm(["kill-pane", "--pane-id", String(job.paneId)]);
		if (res.code !== 0) {
			error = (res.stderr || res.stdout).trim() || `exit code ${res.code}`;
		} else {
			// The command reports success when it accepts the request. The
			// pane list is the evidence that the pane is really gone.
			for (let wait = 0; wait < 20; wait++) {
				if (!(await paneExists(job.paneId))) {
					paneClosed = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			if (!paneClosed) error = "The pane of the worker is still open after the cancel.";
		}
		job.paneClosed = paneClosed;
	}
	await finalizeJob(job, "cancelled", "Cancelled by the main agent", job.result);
	return { paneClosed, error };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** A zod schema builder as the extension API exposes it. */
interface ZodSchema {
	optional: () => ZodSchema;
	describe: (text: string) => ZodSchema;
}

interface ZodLike {
	string: () => ZodSchema;
	number: () => ZodSchema;
	boolean: () => ZodSchema;
	array: (item: unknown) => ZodSchema;
	object: (shape: Record<string, unknown>) => unknown;
}

interface ExtensionAPI {
	registerTool: (def: unknown) => void;
	registerCommand: (name: string, def: unknown) => void;
	/** Register an event handler. */
	on: (event: string, handler: (event: unknown, ctx: EventCtx) => void | Promise<void>) => void;
	/** Label shown by the host for this extension. */
	setLabel?: (label: string) => void;
	logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
	/**
	 * Inject a message into the session.
	 *
	 * `sendUserMessage` is the channel that reliably wakes the main agent:
	 * the text lands in the session as a user message and `triggerTurn`
	 * starts a new turn. Verified against omp 18.12.3.
	 */
	sendUserMessage?: (text: string, options?: { triggerTurn?: boolean }) => void;
	/**
	 * Inject a message with an explicit delivery mode.
	 *
	 * `deliverAs: "steer"` delivers immediately and `triggerTurn` starts a
	 * turn; `"followUp"` queues the message behind the current turn. Used as
	 * a fallback when `sendUserMessage` is unavailable.
	 */
	sendMessage: (
		content: string,
		options?: {
			deliverAs?: "steer" | "followUp" | "nextTurn" | "aside";
			triggerTurn?: boolean;
			attribution?: "user" | "agent";
		},
	) => void;
	zod: ZodLike;
}

interface ToolCtx {
	cwd: string;
}

/**
 * The context an event handler receives.
 *
 * `setInterval` is the host's managed timer: the callback runs with the same
 * isolation as a handler dispatch, so a throw is logged and reported instead
 * of tearing the session down.
 */
interface EventCtx {
	cwd?: string;
	setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (timer: NodeJS.Timeout) => void;
}

export default function weztermWorkerExtension(pi: ExtensionAPI) {
	CONFIG = loadConfig();
	mkdirSync(CONFIG.stateDir, { recursive: true });
	pi.setLabel?.("WezTerm Workers");

	const z = pi.zod;
	const optional = (fn: () => ZodSchema) => fn().optional();

	/**
	 * Deliver a finished worker back to the main session.
	 *
	 * The delivery must wake the main agent, not just drop text into the
	 * transcript. `pi.sendUserMessage(text, { triggerTurn: true })` does
	 * that: the text lands in the session as a user message and a new turn
	 * starts, so the agent acts on the result immediately.
	 *
	 * `pi.sendMessage` with `deliverAs: "steer"` is the fallback for a host
	 * that does not expose `sendUserMessage`.
	 */
	const deliver = (job: Job) => {
		const header =
			job.status === "completed"
				? `Async worker ${job.id} finished (${job.label}).`
				: `Async worker ${job.id} ${job.status} (${job.label}).`;
		const body = job.status === "completed" ? (job.result ?? "") : (job.error ?? job.status);
		const meta = [
			`cwd: ${job.cwd}`,
			job.model ? `model: ${job.model}` : null,
			job.paneId !== null ? `pane: ${job.paneId}` : null,
			job.turns > 0 ? `turns: ${job.turns}` : null,
			job.steers > 0 ? `steers: ${job.steers}` : null,
			job.worktreePath ? `worktree: ${job.worktreePath}` : null,
			job.sessionFile ? `transcript: ${job.sessionFile}` : null,
			job.paneClosed ? "pane: closed" : null,
		]
			.filter((line): line is string => line !== null)
			.join(" | ");
		const text = `${header}\n\n${body}\n\n(${meta})`;
		if (typeof pi.sendUserMessage === "function") {
			pi.sendUserMessage(text, { triggerTurn: true });
			return;
		}
		pi.sendMessage(text, {
			deliverAs: "steer",
			triggerTurn: true,
			attribution: "agent",
		});
	};

	// Re-attach to workers that were still running when the previous OMP
	// process ended. The registry on disk is the only way to find them, so a
	// restart does not lose a running worker.
	//
	// This runs on `session_start`, not in the factory: the host throws
	// `ExtensionRuntimeNotInitializedError` when an action method is called
	// during extension load. The registry itself is read eagerly, because the
	// status tool must list the finished workers straight away.
	const restored = readRegistry();
	for (const job of restored.finished) {
		JOBS.set(job.id, job);
	}

	pi.on("session_start", async (_event, ctx) => {
		// Managed timers: a poll that throws must not tear the session down.
		useTimerHost({
			setInterval: (fn, ms) => {
				const handle = ctx.setInterval(fn, ms);
				handle.unref?.();
				return handle;
			},
		});

		for (const job of restored.alive) {
			JOBS.set(job.id, job);
			// A monitor only makes sense while the pane still exists. A pane
			// that was closed by the user ends the worker instead of hanging
			// forever.
			if (job.paneId === null || (await paneExists(job.paneId))) {
				monitorJob(job, deliver);
				continue;
			}
			job.status = "failed";
			job.error = "Worker pane was closed before this session re-attached";
			job.finishedAt = Date.now();
			persistRegistry();
		}
	});

	pi.on("session_shutdown", () => {
		for (const timer of MONITORS.values()) clearInterval(timer);
		MONITORS.clear();
	});

	// Report a failed poll through the host logger, so a broken worker poll
	// is visible instead of silently swallowed.
	const drainErrors = () => {
		while (EXTENSION_ERRORS.length > 0) {
			const message = EXTENSION_ERRORS.shift();
			if (message) pi.logger?.error?.(`[wezterm-worker] ${message}`);
		}
	};
	pi.on("tool_result", drainErrors);
	pi.on("session_end", drainErrors);

	// -----------------------------------------------------------------------
	// wezterm_spawn_worker
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_spawn_worker",
		label: "Spawn WezTerm Worker",
		description:
			"Spawn a background OMP worker session in its own WezTerm pane so the user can watch it live. " +
			"The worker is an independent omp process with its own model, tools and session file — it does " +
			"NOT inherit this conversation. Returns immediately with a worker id, pane id and transcript path; " +
			"the final result is delivered back into this session automatically when the worker finishes. " +
			"Use for long read-only or independent tasks. Prefer the native `task` tool when no pane is needed.",
		parameters: z.object({
			task: z.string().describe("Self-contained instructions for the worker. It sees only this text."),
			cwd: optional(() => z.string()).describe(
				"Absolute working directory for the worker. Defaults to the current session cwd.",
			),
			label: optional(() => z.string()).describe("Short human label shown in the pane title and in reports."),
			model: optional(() => z.string()).describe(
				"Model selector for the worker, e.g. 'omniroute/minimax/MiniMax-M3.1-Flash'. Omit to use omp's default.",
			),
			tools: optional(() => z.array(z.string())).describe(
				"Tool list for the worker, e.g. ['read','grep','glob']. Omit for the default tool set.",
			),
			placement: optional(() => z.string()).describe(
				"'split' (default) splits the current pane; 'tab' opens a new tab in the current window.",
			),
			isolated: optional(() => z.boolean()).describe(
				"Run the worker in its own git worktree so parallel workers never edit the same checkout.",
			),
			timeoutMs: optional(() => z.number()).describe(
				"Deadline for this worker in ms. 0 means no deadline. Defaults to the configured timeoutMs (30 min). Use a large value for a task that legitimately takes hours.",
			),
			closePaneOnFinish: optional(() => z.boolean()).describe(
				"Close the worker pane when the worker finishes. Defaults to the config value (true). Set false to keep the pane open for inspection.",
			),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: {
				task: string;
				cwd?: string;
				label?: string;
				model?: string;
				tools?: string[];
				placement?: string;
				isolated?: boolean;
				timeoutMs?: number;
				closePaneOnFinish?: boolean;
			},
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ToolCtx,
		) {
			const placement: Placement =
				params.placement === "tab" || params.placement === "split" ? params.placement : CONFIG.placement;
			const job = await spawnWorker({
				task: params.task,
				cwd: params.cwd || ctx.cwd,
				label: params.label,
				model: params.model,
				tools: params.tools,
				placement,
				isolated: params.isolated,
				timeoutMs: params.timeoutMs,
				closePaneOnFinish: params.closePaneOnFinish,
			});

			if (job.status === "failed") {
				return {
					content: [{ type: "text", text: `Worker failed to start: ${job.error ?? "unknown error"}` }],
					details: { workerId: job.id, status: job.status, error: job.error },
					isError: true,
				};
			}

			monitorJob(job, deliver);

			const lines = [
				`Worker ${job.id} started in pane ${job.paneId}.`,
				`cwd: ${job.cwd}`,
				job.model ? `model: ${job.model}` : null,
				job.worktreePath ? `isolated worktree: ${job.worktreePath} (branch ${job.worktreeBranch})` : null,
				`transcript: ${job.sessionDir}`,
				"",
				"The worker runs in the background. Its final result is delivered back into this session automatically.",
			].filter((line): line is string => line !== null);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					workerId: job.id,
					paneId: job.paneId,
					tabId: job.tabId,
					windowId: job.windowId,
					status: job.status,
					cwd: job.cwd,
					transcriptDir: job.sessionDir,
					worktreePath: job.worktreePath,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_status
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_status",
		label: "WezTerm Worker Status",
		description:
			"List the WezTerm pane workers of this session, or inspect one by id. " +
			"Returns lifecycle state (queued/running/completed/failed/cancelled), pane id, cwd, transcript path, " +
			"elapsed time, time since the last worker activity, the tool the worker is running right now, " +
			"how many turns it took, and whether its pane is still alive.",
		parameters: z.object({
			workerId: optional(() => z.string()).describe("Inspect a single worker. Omit to list all."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId?: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const all = [...JOBS.values()].sort((a, b) => b.createdAt - a.createdAt);
			const jobs = params.workerId ? all.filter((j) => j.id === params.workerId) : all;
			if (jobs.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.workerId
								? `Unknown worker id: ${params.workerId}`
								: "No workers have been spawned in this process.",
						},
					],
					details: { workers: [] },
					isError: Boolean(params.workerId),
				};
			}
			const now = Date.now();
			// Re-read the transcript so the reported activity is current rather
			// than the value from the last monitor tick.
			for (const job of jobs) {
				if (job.status !== "running" && job.status !== "queued") continue;
				const files = listSessionFiles(job.sessionDir);
				if (files.length === 0) continue;
				const summary = summarizeSession(files[0]);
				job.sessionFile = files[0];
				job.currentTool = summary.currentTool;
				job.turns = summary.turns;
				try {
					const size = statSync(files[0]).size;
					if (size !== job.lastTranscriptSize) {
						job.lastActivityAt = now;
						job.lastTranscriptSize = size;
					}
				} catch {
					/* the transcript is being written; the next poll retries */
				}
			}
			const rows = jobs.map((j) => ({
				workerId: j.id,
				label: j.label,
				status: j.status,
				paneId: j.paneId,
				cwd: j.cwd,
				model: j.model,
				transcript: j.sessionFile ?? j.sessionDir,
				elapsedMs: (j.finishedAt ?? now) - (j.startedAt ?? j.createdAt),
				idleMs: j.finishedAt ? 0 : now - j.lastActivityAt,
				currentTool: j.currentTool,
				turns: j.turns,
				steers: j.steers,
				timeoutMs: j.timeoutMs,
				paneClosed: j.paneClosed,
				worktreePath: j.worktreePath,
				worktreeBranch: j.worktreeBranch,
				worktreeDirty: j.worktreeDirty,
				error: j.error,
			}));
			const text = rows
				.map((r) =>
					[
						`${r.workerId}  ${r.status.toUpperCase()}`,
						`  label      : ${r.label}`,
						`  pane      : ${r.paneId === null ? "-" : r.paneClosed ? "(closed)" : r.paneId}`,
						`  cwd       : ${r.cwd}`,
						`  model     : ${r.model ?? "(default)"}`,
						`  transcript: ${r.transcript}`,
						`  elapsed   : ${Math.round(r.elapsedMs / 1000)}s` +
							(r.timeoutMs > 0 ? ` (timeout at ${Math.round(r.timeoutMs / 1000)}s)` : " (no timeout)"),
						r.status === "running" || r.status === "queued"
							? `  idle      : ${Math.round(r.idleMs / 1000)}s since last activity`
							: null,
						r.currentTool ? `  running   : ${r.currentTool}` : null,
						`  turns     : ${r.turns}${r.steers > 0 ? ` (${r.steers} steering message(s))` : ""}`,
						r.worktreePath
							? `  worktree  : ${r.worktreePath} (branch ${r.worktreeBranch ?? "-"})` +
								(r.worktreeDirty === true ? " [has uncommitted changes]" : "")
							: null,
						r.error ? `  error     : ${r.error}` : null,
					]
						.filter((line): line is string => line !== null)
						.join("\n"),
				)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { workers: rows } };
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_steer
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_steer",
		label: "Steer WezTerm Worker",
		description:
			"Send a new instruction into a running worker, exactly as if the user typed it into the worker's pane. " +
			"The worker receives it as a follow-up user message and continues working. " +
			"Use this to redirect a long-running worker without cancelling it.",
		parameters: z.object({
			workerId: z.string().describe("Id of the running worker to steer."),
			message: z.string().describe("The instruction to send into the worker."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; message: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const job = JOBS.get(params.workerId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown worker id: ${params.workerId}` }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.status !== "running" && job.status !== "queued") {
				return {
					content: [
						{
							type: "text",
							text: `Worker ${job.id} is already ${job.status} and cannot be steered.`,
						},
					],
					details: { workerId: job.id, status: job.status },
					isError: true,
				};
			}
			if (job.paneId === null) {
				return {
					content: [{ type: "text", text: `Worker ${job.id} has no pane yet.` }],
					details: { workerId: job.id, status: job.status },
					isError: true,
				};
			}
			if (!(await paneExists(job.paneId))) {
				return {
					content: [
						{ type: "text", text: `The pane of worker ${job.id} is gone. The worker process exited.` },
					],
					details: { workerId: job.id, status: job.status, paneId: job.paneId },
					isError: true,
				};
			}
			const steered = await steerWorker(job, params.message);
			if (!steered.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Could not send to worker ${job.id}: ${steered.error ?? "unknown error"}`,
						},
					],
					details: {
						workerId: job.id,
						status: job.status,
						paneId: job.paneId,
						error: steered.error,
						attempts: steered.attempts,
					},
					isError: true,
				};
			}
			job.steers += 1;
			job.lastActivityAt = Date.now();
			return {
				content: [
					{
						type: "text",
						text:
							"Sent to worker " +
							job.id +
							" in pane " +
							job.paneId +
							":\n" +
							params.message +
							"\n\nThe worker continues working; its final result is still delivered back automatically.",
					},
				],
				details: {
					workerId: job.id,
					status: job.status,
					paneId: job.paneId,
					steers: job.steers,
					attempts: steered.attempts,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_peek
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_peek",
		label: "Peek At WezTerm Worker Pane",
		description:
			"Show the last visible lines of a worker's pane. A debug aid for a worker that looks stuck. " +
			"The transcript remains the source of truth for the result; this only shows what is on screen.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to peek at."),
			lines: optional(() => z.number()).describe("How many lines to show. Default 20."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; lines?: number },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const job = JOBS.get(params.workerId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown worker id: ${params.workerId}` }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.paneId === null) {
				return {
					content: [{ type: "text", text: `Worker ${job.id} has no pane.` }],
					details: { workerId: job.id },
					isError: true,
				};
			}
			const text = await paneTail(job.paneId, params.lines ?? 20);
			if (!text) {
				return {
					content: [{ type: "text", text: "No pane text available. The pane may be closed." }],
					details: { workerId: job.id, paneId: job.paneId, alive: await paneExists(job.paneId) },
				};
			}
			return {
				content: [{ type: "text", text }],
				details: { workerId: job.id, paneId: job.paneId, alive: await paneExists(job.paneId) },
			};
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_result
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_result",
		label: "WezTerm Worker Result",
		description: "Read a finished worker's output. Returns the final assistant text of the worker session.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to read."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const job = JOBS.get(params.workerId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown worker id: ${params.workerId}` }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.result === null && (job.status === "running" || job.status === "queued")) {
				return {
					content: [{ type: "text", text: `Worker ${job.id} is still ${job.status}.` }],
					details: { workerId: job.id, status: job.status },
				};
			}
			return {
				content: [{ type: "text", text: job.result ?? job.error ?? "(no output)" }],
				details: {
					workerId: job.id,
					status: job.status,
					result: job.result,
					error: job.error,
					cwd: job.cwd,
					transcript: job.sessionFile ?? job.sessionDir,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_resume
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_resume",
		label: "Resume WezTerm Worker",
		description:
			"Reopen a finished worker in a new WezTerm pane, continuing its transcript. " +
			"The worker comes back with its full history, so it can be given a follow-up instruction. " +
			"Use this to continue work that a completed worker started.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to resume."),
			message: optional(() => z.string()).describe(
				"Follow-up instruction for the worker. Omit to reopen it without a new instruction.",
			),
			placement: optional(() => z.string()).describe("'split' (default) or 'tab'."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; message?: string; placement?: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const job = JOBS.get(params.workerId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown worker id: ${params.workerId}` }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.status === "running" || job.status === "queued") {
				return {
					content: [
						{
							type: "text",
							text: `Worker ${job.id} is still ${job.status}. Steer it instead of resuming it.`,
						},
					],
					details: { workerId: job.id, status: job.status },
					isError: true,
				};
			}
			const placement: Placement = params.placement === "tab" ? "tab" : "split";
			const resumed = await resumeWorker(job, { message: params.message, placement });
			if (resumed.status === "failed") {
				return {
					content: [{ type: "text", text: `Could not resume worker: ${resumed.error ?? "unknown error"}` }],
					details: { workerId: resumed.id, status: resumed.status, error: resumed.error },
					isError: true,
				};
			}
			monitorJob(resumed, deliver);
			return {
				content: [
					{
						type: "text",
						text:
							"Worker " +
							job.id +
							" resumed as " +
							resumed.id +
							" in pane " +
							resumed.paneId +
							".\n" +
							"transcript: " +
							(resumed.sessionFile ?? resumed.sessionDir) +
							"\n\n" +
							"It continues from its transcript. Its next result is delivered back automatically.",
					},
				],
				details: {
					workerId: resumed.id,
					resumedFrom: job.id,
					paneId: resumed.paneId,
					status: resumed.status,
					transcript: resumed.sessionFile ?? resumed.sessionDir,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_cancel
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_cancel",
		label: "Cancel WezTerm Worker",
		description:
			"Cancel a running worker and close only the pane that worker created. " +
			"Never touches other panes or processes.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to cancel."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const job = JOBS.get(params.workerId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown worker id: ${params.workerId}` }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
				return {
					content: [{ type: "text", text: `Worker ${job.id} is already ${job.status}.` }],
					details: { workerId: job.id, status: job.status },
				};
			}
			const cancelled = await cancelJob(job);
			if (cancelled.error) {
				return {
					content: [
						{
							type: "text",
							text: `Worker ${job.id} was cancelled, but its pane did not close: ${cancelled.error}`,
						},
					],
					details: {
						workerId: job.id,
						status: job.status,
						paneId: job.paneId,
						paneClosed: cancelled.paneClosed,
						error: cancelled.error,
					},
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Worker ${job.id} cancelled. Pane ${job.paneId} closed.` }],
				details: { workerId: job.id, status: job.status, paneId: job.paneId, paneClosed: true },
			};
		},
	});

	// -----------------------------------------------------------------------
	// wezterm_worker_cleanup
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "wezterm_worker_cleanup",
		label: "Clean Up WezTerm Worker",
		description:
			"Release the resources of a finished worker: remove its isolated git worktree and " +
			"delete its transcript directory. A worktree with uncommitted changes is kept " +
			"unless force is set, so the work of the worker is never thrown away. " +
			"Does not touch other workers or user panes.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to clean up."),
			force: z
				.boolean()
				.optional()
				.describe(
					"Remove the worktree even when it holds uncommitted changes or untracked files. " +
						"Without this the worktree is kept and the changes are reported.",
				),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; force?: boolean },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const job = JOBS.get(params.workerId);
			if (!job) {
				return {
					content: [{ type: "text", text: `Unknown worker id: ${params.workerId}` }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.status === "running" || job.status === "queued") {
				return {
					content: [{ type: "text", text: `Worker ${job.id} is still ${job.status}. Cancel it first.` }],
					details: { workerId: job.id, status: job.status },
					isError: true,
				};
			}
			const notes: string[] = [];
			let keptWorktree: string | null = null;
			let keptChanges: string[] = [];
			if (job.worktreePath) {
				if (job.paneId !== null && (await paneExists(job.paneId))) {
					notes.push(`worktree kept: close pane ${job.paneId} first, it holds the directory`);
					keptWorktree = job.worktreePath;
				} else {
					// Never throw away work. A checkout with uncommitted edits,
					// untracked files or stashes holds the worker's output, so
					// it survives unless the caller forces the removal.
					const state = await inspectWorktree(job.worktreePath);
					if (!state.exists) {
						notes.push(`worktree already gone: ${job.worktreePath}`);
					} else if (!state.clean && !params.force) {
						keptWorktree = job.worktreePath;
						keptChanges = state.changes;
						notes.push(
							"worktree kept: it has uncommitted changes (" +
								state.changes.length +
								"). Keep it, or pass force to discard them.",
						);
						for (const change of state.changes) notes.push(`  ${change}`);
					} else {
						const origin = job.worktreeOrigin ?? job.cwd;
						const out = await removeWorktree(origin, job.worktreePath);
						if (out.removed) {
							notes.push(`worktree removed: ${job.worktreePath}`);
							if (job.worktreeBranch) {
								notes.push(`branch kept (commits made by the worker survive): ${job.worktreeBranch}`);
							}
							job.worktreePath = null;
							job.worktreeBranch = null;
						} else {
							notes.push(`worktree NOT removed (${out.error ?? "unknown"}): ${job.worktreePath}`);
							keptWorktree = job.worktreePath;
						}
					}
				}
			}
			try {
				rmSync(job.sessionDir, { recursive: true, force: true });
				notes.push(`transcript directory removed: ${job.sessionDir}`);
			} catch (e) {
				notes.push(`transcript directory NOT removed: ${String(e)}`);
			}
			persistRegistry();
			return {
				content: [{ type: "text", text: `Cleanup for worker ${job.id}:\n- ${notes.join("\n- ")}` }],
				details: {
					workerId: job.id,
					notes,
					keptWorktree,
					keptChanges,
					worktreeRemoved: job.worktreePath === null,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// /wezterm-workers — human-facing roster
	// -----------------------------------------------------------------------
	pi.registerCommand("wezterm-workers", {
		description: "Show the WezTerm pane workers of this session.",
		handler: async (_args: string, ctx: { ui?: { notify?: (message: string, level?: string) => void } }) => {
			const jobs = [...JOBS.values()].sort((a, b) => b.createdAt - a.createdAt);
			if (jobs.length === 0) {
				ctx.ui?.notify?.("No WezTerm workers in this session.", "info");
				return;
			}
			const text = jobs.map((j) => `${j.id}  ${j.status}  pane=${j.paneId ?? "-"}  ${j.label}`).join("\n");
			ctx.ui?.notify?.(text, "info");
		},
	});
}

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
 * `pi.sendMessage` (an OMP-supported delivery channel), so the main agent sees
 * it without the user having to read a file.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_FILE = join(homedir(), ".omp", "agent", "wezterm-worker.json");

type Placement = "split" | "tab";

interface WorkerConfig {
	ompBin: string;
	weztermBin: string;
	placement: Placement;
	stateDir: string;
	defaultCwd: string;
	model: string | null;
	tools: string[] | null;
	pollMs: number;
	timeoutMs: number;
	isolated: boolean;
}

const DEFAULT_CONFIG: WorkerConfig = {
	ompBin: "omp",
	weztermBin: "wezterm",
	placement: "split",
	stateDir: join(homedir(), ".omp", "agent", "wezterm-workers"),
	defaultCwd: process.cwd(),
	model: null,
	tools: null,
	pollMs: 2000,
	timeoutMs: 30 * 60 * 1000,
	isolated: false,
};

/** Static string-keyed table: config key -> the config field it overrides. */
const CONFIG_STRING_KEYS = ["ompBin", "weztermBin", "stateDir", "defaultCwd"] as const;
const CONFIG_NUMBER_KEYS = ["pollMs", "timeoutMs"] as const;
const CONFIG_BOOLEAN_KEYS = ["isolated"] as const;

function loadConfig(): WorkerConfig {
	const cfg: WorkerConfig = { ...DEFAULT_CONFIG };
	try {
		if (existsSync(CONFIG_FILE)) {
			const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
			for (const key of CONFIG_STRING_KEYS) {
				const v = raw[key];
				if (typeof v === "string") cfg[key] = v;
			}
			for (const key of CONFIG_NUMBER_KEYS) {
				const v = raw[key];
				if (typeof v === "number") cfg[key] = v;
			}
			for (const key of CONFIG_BOOLEAN_KEYS) {
				const v = raw[key];
				if (typeof v === "boolean") cfg[key] = v;
			}
			if (raw.placement === "split" || raw.placement === "tab") cfg.placement = raw.placement;
			if (typeof raw.model === "string") cfg.model = raw.model;
			if (Array.isArray(raw.tools)) cfg.tools = raw.tools.map(String);
		}
	} catch (e) {
		void e;
	}
	// Environment overrides win over the file so a caller can retarget binaries.
	if (process.env.OMP_WORKER_OMP_BIN) cfg.ompBin = process.env.OMP_WORKER_OMP_BIN;
	if (process.env.OMP_WORKER_WEZTERM_BIN) cfg.weztermBin = process.env.OMP_WORKER_WEZTERM_BIN;
	if (process.env.OMP_WORKER_STATE_DIR) cfg.stateDir = process.env.OMP_WORKER_STATE_DIR;
	return cfg;
}

// ---------------------------------------------------------------------------
// Job registry (module scope: shared by every session this factory binds)
// ---------------------------------------------------------------------------

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface Job {
	id: string;
	label: string;
	task: string;
	cwd: string;
	model: string | null;
	tools: string[] | null;
	status: JobStatus;
	paneId: number | null;
	tabId: number | null;
	windowId: number | null;
	placement: Placement;
	sessionDir: string;
	sessionFile: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	result: string | null;
	error: string | null;
	worktreePath: string | null;
	worktreeBranch: string | null;
	/** Repository the isolated worktree was created from. */
	worktreeOrigin: string | null;
	cancelled: boolean;
}

const JOBS = new Map<string, Job>();
const MONITORS = new Map<string, NodeJS.Timeout>();
const REAPERS = new Map<string, NodeJS.Timeout>();
let JOB_SEQ = 0;

/**
 * Effective configuration. Replaced on every factory bind so a session picks up
 * the current file/env values. Module scope is required: child sessions rebind
 * the factory but must observe the same job registry.
 */
let CONFIG: WorkerConfig = { ...DEFAULT_CONFIG };

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
		throw new Error("Isolation requested but cwd is not a git repository: " + cwd);
	}
	const base = join(CONFIG.stateDir, "worktrees", jobId);
	mkdirSync(join(CONFIG.stateDir, "worktrees"), { recursive: true });
	const branch = "omp/worker/" + jobId;
	const res = await git(cwd, ["worktree", "add", "-b", branch, base, "HEAD"]);
	if (res.code !== 0) {
		throw new Error("git worktree add failed: " + (res.stderr || res.stdout).trim());
	}
	return { path: base, branch };
}

// ---------------------------------------------------------------------------
// Worker session inspection
// ---------------------------------------------------------------------------

interface SessionSummary {
	userMessages: string[];
	assistantTexts: string[];
	toolCalls: number;
	toolResults: number;
}

interface ContentBlock {
	type?: string;
	text?: string;
}

function listSessionFiles(sessionDir: string): string[] {
	try {
		if (!existsSync(sessionDir)) return [];
		return readdirSync(sessionDir)
			.filter(f => f.endsWith(".jsonl"))
			.map(f => join(sessionDir, f))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	} catch {
		return [];
	}
}

function summarizeSession(file: string): SessionSummary {
	const summary: SessionSummary = {
		userMessages: [],
		assistantTexts: [],
		toolCalls: 0,
		toolResults: 0,
	};
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return summary;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: ContentBlock[] } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
		if (role === "user") {
			const text = blocks
				.filter(b => b.type === "text")
				.map(b => b.text ?? "")
				.join("");
			if (text) summary.userMessages.push(text);
		} else if (role === "assistant") {
			const text = blocks
				.filter(b => b.type === "text")
				.map(b => b.text ?? "")
				.join("");
			if (text) summary.assistantTexts.push(text);
			summary.toolCalls += blocks.filter(b => b.type === "toolCall").length;
		} else if (role === "toolResult") {
			summary.toolResults += 1;
		}
	}
	return summary;
}

/**
 * A worker turn is complete when its session file holds a final assistant text
 * block and no tool call is still outstanding.
 */
function isTurnComplete(summary: SessionSummary): boolean {
	return summary.assistantTexts.length > 0 && summary.toolCalls <= summary.toolResults;
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
		cancelled: false,
	};
	JOBS.set(jobId, job);

	if (!existsSync(job.cwd)) {
		job.status = "failed";
		job.error = "cwd does not exist: " + job.cwd;
		job.finishedAt = Date.now();
		return job;
	}

	// Pre-flight the omp binary. A worker that cannot start leaves an empty
	// pane and never writes a transcript, so failing here reports the real
	// cause instead of a generic startup timeout.
	const ompCheck = await run(CONFIG.ompBin, ["--version"]);
	if (ompCheck.code !== 0) {
		job.status = "failed";
		job.error =
			"Cannot run the omp binary '" +
			CONFIG.ompBin +
			"': " +
			(ompCheck.stderr || ompCheck.stdout || "exit code " + ompCheck.code).trim();
		job.finishedAt = Date.now();
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
			job.status = "failed";
			job.error = e instanceof Error ? e.message : String(e);
			job.finishedAt = Date.now();
			return job;
		}
	}

	// omp argv — every value is its own argv element.
	const ompArgs: string[] = ["--no-title", "--cwd", job.cwd, "--session-dir", job.sessionDir];
	if (job.model) ompArgs.push("--model", job.model);
	if (job.tools && job.tools.length) ompArgs.push("--tools", job.tools.join(","));
	// The task is a single argv element: no shell parsing, no quoting hazards.
	ompArgs.push(job.task);

	// wezterm argv — placement decides the CLI verb.
	const weztermArgs: string[] =
		job.placement === "tab"
			? ["spawn", "--cwd", job.cwd, "--", CONFIG.ompBin, ...ompArgs]
			: ["split-pane", "--right", "--cwd", job.cwd, "--", CONFIG.ompBin, ...ompArgs];

	const res = await wezterm(weztermArgs);
	if (res.code !== 0) {
		job.status = "failed";
		job.error = "wezterm " + job.placement + " failed: " + (res.stderr || res.stdout).trim();
		job.finishedAt = Date.now();
		return job;
	}

	const paneId = Number.parseInt(res.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
		job.status = "failed";
		job.error = "wezterm did not return a pane id (got: " + JSON.stringify(res.stdout) + ")";
		job.finishedAt = Date.now();
		return job;
	}
	job.paneId = paneId;
	job.status = "running";
	job.startedAt = Date.now();

	// Record which tab/window the pane landed in, so the user can find it.
	const listing = await wezterm(["list", "--format", "json"]);
	if (listing.code === 0) {
		try {
			const panes = JSON.parse(listing.stdout) as Array<{
				pane_id: number;
				tab_id: number;
				window_id: number;
			}>;
			const found = panes.find(p => p.pane_id === paneId);
			if (found) {
				job.tabId = found.tab_id;
				job.windowId = found.window_id;
			}
		} catch {
			/* tab metadata is best-effort */
		}
	}

	// Name the tab so the user can find the worker in the tab bar.
	await wezterm(["set-tab-title", "--pane-id", String(paneId), "OMP worker " + job.id]);

	// An isolated worktree is released once its pane closes.
	if (job.worktreePath && job.worktreeOrigin) reapWorktree(job, job.worktreeOrigin);

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

function finalizeJob(job: Job, status: JobStatus, error: string | null, result: string | null): void {
	job.status = status;
	job.error = error;
	job.result = result;
	job.finishedAt = Date.now();
	stopMonitor(job.id);
}

/**
 * Remove a worker's isolated worktree.
 *
 * The worker's pane keeps the directory open, so the removal only succeeds
 * after that pane is gone. Returns the removal outcome instead of throwing.
 */
async function removeWorktree(cwd: string, path: string): Promise<{ removed: boolean; error: string | null }> {
	const res = await git(cwd, ["worktree", "remove", "--force", path]);
	if (res.code === 0) return { removed: true, error: null };
	// Fall back to a plain directory delete when git refuses (e.g. the branch
	// was already checked out elsewhere or the metadata is stale).
	try {
		rmSync(path, { recursive: true, force: true });
		if (!existsSync(path)) return { removed: true, error: null };
	} catch (e) {
		return { removed: false, error: e instanceof Error ? e.message : String(e) };
	}
	return { removed: false, error: (res.stderr || res.stdout).trim() };
}

async function paneExists(paneId: number): Promise<boolean> {
	const listing = await wezterm(["list", "--format", "json"]);
	if (listing.code !== 0) return false;
	try {
		const panes = JSON.parse(listing.stdout) as Array<{ pane_id: number }>;
		return panes.some(p => p.pane_id === paneId);
	} catch {
		return false;
	}
}

/**
 * Reap an isolated worktree once its pane is closed.
 *
 * The worker's OMP process holds the worktree directory open, so the worktree
 * can only be removed after the user closes the pane. This reaper waits for
 * that, then releases the checkout.
 *
 * `originCwd` is the repository the worktree was created from, not the
 * worktree itself: `git worktree remove` must not run from inside the
 * directory it is deleting.
 */
function reapWorktree(job: Job, originCwd: string): void {
	if (!job.worktreePath) return;
	const path = job.worktreePath;
	const paneId = job.paneId;
	const timer = setInterval(() => {
		void (async () => {
			if (paneId !== null && (await paneExists(paneId))) return;
			const out = await removeWorktree(originCwd, path);
			if (out.removed) {
				clearInterval(timer);
				REAPERS.delete(job.id);
			}
		})();
	}, 5000);
	timer.unref?.();
	REAPERS.set(job.id, timer);
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
	const cap = CONFIG.timeoutMs;
	const startupGraceMs = 45_000;
	const timer = setInterval(() => {
		if (job.status !== "running" && job.status !== "queued") {
			stopMonitor(job.id);
			return;
		}
		const elapsed = Date.now() - (job.startedAt ?? job.createdAt);
		if (cap > 0 && elapsed > cap) {
			finalizeJob(job, "failed", "Worker timed out after " + Math.round(cap / 1000) + "s", null);
			notify(job);
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
				finalizeJob(
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
		job.sessionFile = file;
		const summary = summarizeSession(file);
		if (!isTurnComplete(summary)) return;

		const finalText = summary.assistantTexts[summary.assistantTexts.length - 1] ?? "";
		if (job.cancelled) {
			finalizeJob(job, "cancelled", "Worker cancelled", finalText || null);
			notify(job);
			return;
		}
		finalizeJob(job, "completed", null, finalText);
		notify(job);
	}, CONFIG.pollMs);
	// Never keep the host process alive because of the poller.
	timer.unref?.();
	MONITORS.set(job.id, timer);
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

async function cancelJob(job: Job): Promise<void> {
	job.cancelled = true;
	// Kill only the pane this extension created. Never touch other panes.
	if (job.paneId !== null) {
		await wezterm(["kill-pane", "--pane-id", String(job.paneId)]);
	}
	finalizeJob(job, "cancelled", "Cancelled by the main agent", job.result);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface ZodLike {
	string: () => { optional: () => unknown };
	number: () => { optional: () => unknown };
	boolean: () => { optional: () => unknown };
	array: (item: unknown) => { optional: () => unknown };
	object: (shape: Record<string, unknown>) => unknown;
}

interface ExtensionApi {
	registerTool: (def: unknown) => void;
	registerCommand: (name: string, def: unknown) => void;
	logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
	sendMessage: (
		content: string,
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean; attribution?: "user" | "agent" },
	) => void;
	zod: ZodLike;
}

interface ToolCtx {
	cwd: string;
}

export default function weztermWorkerExtension(pi: ExtensionApi) {
	CONFIG = loadConfig();
	mkdirSync(CONFIG.stateDir, { recursive: true });

	const z = pi.zod;
	const optional = (fn: () => unknown) => fn().optional();

	/**
	 * Deliver a finished worker back to the main session.
	 * `pi.sendMessage` is an OMP-supported delivery channel: the main agent
	 * sees the result without the user having to read a file.
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
			job.worktreePath ? `worktree: ${job.worktreePath}` : null,
			job.sessionFile ? `transcript: ${job.sessionFile}` : null,
		]
			.filter((line): line is string => line !== null)
			.join(" | ");
		pi.sendMessage(`${header}\n\n${body}\n\n(${meta})`, {
			deliverAs: "followUp",
			triggerTurn: true,
			attribution: "agent",
		});
	};

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
			cwd: optional(() => z.string()).describe("Absolute working directory for the worker. Defaults to the current session cwd."),
			label: optional(() => z.string()).describe("Short human label shown in the pane title and in reports."),
			model: optional(() => z.string()).describe("Model selector for the worker, e.g. 'omniroute/minimax/MiniMax-M3.1-Flash'. Omit to use omp's default."),
			tools: optional(() => z.array(z.string())).describe("Tool list for the worker, e.g. ['read','grep','glob']. Omit for the default tool set."),
			placement: optional(() => z.string()).describe("'split' (default) splits the current pane; 'tab' opens a new tab in the current window."),
			isolated: optional(() => z.boolean()).describe("Run the worker in its own git worktree so parallel workers never edit the same checkout."),
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
			});

			if (job.status === "failed") {
				return {
					content: [{ type: "text", text: "Worker failed to start: " + (job.error ?? "unknown error") }],
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
			"Returns lifecycle state (queued/running/completed/failed/cancelled), pane id, cwd and transcript path.",
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
			const jobs = params.workerId ? all.filter(j => j.id === params.workerId) : all;
			if (jobs.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.workerId
								? "Unknown worker id: " + params.workerId
								: "No workers have been spawned in this process.",
						},
					],
					details: { workers: [] },
					isError: Boolean(params.workerId),
				};
			}
			const rows = jobs.map(j => ({
				workerId: j.id,
				label: j.label,
				status: j.status,
				paneId: j.paneId,
				cwd: j.cwd,
				model: j.model,
				transcript: j.sessionFile ?? j.sessionDir,
				elapsedMs: (j.finishedAt ?? Date.now()) - (j.startedAt ?? j.createdAt),
				error: j.error,
			}));
			const text = rows
				.map(r =>
					[
						`${r.workerId}  ${r.status.toUpperCase()}`,
						`  label      : ${r.label}`,
						`  pane      : ${r.paneId ?? "-"}`,
						`  cwd       : ${r.cwd}`,
						`  model     : ${r.model ?? "(default)"}`,
						`  transcript: ${r.transcript}`,
						`  elapsed   : ${Math.round(r.elapsedMs / 1000)}s`,
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
					content: [{ type: "text", text: "Unknown worker id: " + params.workerId }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.result === null && (job.status === "running" || job.status === "queued")) {
				return {
					content: [
						{ type: "text", text: "Worker " + job.id + " is still " + job.status + "." },
					],
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
					content: [{ type: "text", text: "Unknown worker id: " + params.workerId }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
				return {
					content: [{ type: "text", text: "Worker " + job.id + " is already " + job.status + "." }],
					details: { workerId: job.id, status: job.status },
				};
			}
			await cancelJob(job);
			return {
				content: [
					{ type: "text", text: "Worker " + job.id + " cancelled. Pane " + job.paneId + " closed." },
				],
				details: { workerId: job.id, status: job.status, paneId: job.paneId },
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
			"delete its transcript directory. Does not touch other workers or user panes.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to clean up."),
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
					content: [{ type: "text", text: "Unknown worker id: " + params.workerId }],
					details: { known: [...JOBS.keys()] },
					isError: true,
				};
			}
			if (job.status === "running" || job.status === "queued") {
				return {
					content: [
						{ type: "text", text: "Worker " + job.id + " is still " + job.status + ". Cancel it first." },
					],
					details: { workerId: job.id, status: job.status },
					isError: true,
				};
			}
			const notes: string[] = [];
			if (job.worktreePath) {
				if (job.paneId !== null && (await paneExists(job.paneId))) {
					notes.push("worktree kept: close pane " + job.paneId + " first, it holds the directory");
				} else {
					const origin = job.worktreeOrigin ?? job.cwd;
					const out = await removeWorktree(origin, job.worktreePath);
					notes.push(
						out.removed
							? "worktree removed: " + job.worktreePath
							: "worktree NOT removed (" + (out.error ?? "unknown") + "): " + job.worktreePath,
					);
				}
			}
			try {
				rmSync(job.sessionDir, { recursive: true, force: true });
				notes.push("transcript directory removed: " + job.sessionDir);
			} catch (e) {
				notes.push("transcript directory NOT removed: " + String(e));
			}
			return {
				content: [{ type: "text", text: "Cleanup for worker " + job.id + ":\n- " + notes.join("\n- ") }],
				details: { workerId: job.id, notes },
			};
		},
	});

	// -----------------------------------------------------------------------
	// /wezterm-workers — human-facing roster
	// -----------------------------------------------------------------------
	pi.registerCommand("wezterm-workers", {
		description: "Show the WezTerm pane workers of this session.",
		handler: async (
			_args: string,
			ctx: { ui?: { notify?: (message: string, level?: string) => void } },
		) => {
			const jobs = [...JOBS.values()].sort((a, b) => b.createdAt - a.createdAt);
			if (jobs.length === 0) {
				ctx.ui?.notify?.("No WezTerm workers in this session.", "info");
				return;
			}
			const text = jobs
				.map(j => `${j.id}  ${j.status}  pane=${j.paneId ?? "-"}  ${j.label}`)
				.join("\n");
			ctx.ui?.notify?.(text, "info");
		},
	});
}

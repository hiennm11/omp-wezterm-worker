/**
 * The helpers of the tests of the prune.
 *
 * The tests use a real git repository, a real worktree and the real git
 * commands. The runtime runs the real programs, so the tool acts on a real
 * repository. The tests start no pane.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { run } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";

/** The number of milliseconds of one day. */
const DAY = 24 * 60 * 60 * 1000;

/** A tool that the fake host records. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
		extra?: unknown,
		fifth?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A zod stub that accepts every parameter object. */
export function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, boolean: () => chain, object: () => chain } as never;
}

/** The repository, the state directory and the runtime of a test. */
export interface PruneFixture {
	rt: WorkerRuntime;
	dir: string;
	stateDir: string;
	repo: string;
	origin: string;
	now: number;
}

/** Run a git command and fail the test when the command fails. */
export async function git(cwd: string, args: string[]): Promise<string> {
	const result = await run("git", args, cwd);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

/** True when the repository holds the branch. */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
	const list = await git(repo, ["branch", "--list", branch]);
	return list.trim().length > 0;
}

/**
 * Build a repository with a bare origin and a clone.
 *
 * The clone holds a branch `main` that the origin holds too. The default
 * branch of the clone is the target of `refs/remotes/origin/HEAD`, so the
 * prune finds it without a parameter.
 */
export async function pruneFixture(options: { defaultBranch?: boolean } = {}): Promise<PruneFixture> {
	const dir = mkdtempSync(join(tmpdir(), "wt-prune-"));
	const stateDir = join(dir, "state");
	const origin = join(dir, "origin.git");
	const repo = join(dir, "repo");
	mkdirSync(stateDir, { recursive: true });
	await git(dir, ["init", "--bare", "-b", "main", origin]);
	await git(dir, ["init", "-b", "main", repo]);
	await git(repo, ["config", "user.name", "Test"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "# repo\n", "utf8");
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-m", "init"]);
	await git(repo, ["remote", "add", "origin", origin]);
	await git(repo, ["push", "-u", "origin", "main"]);
	if (options.defaultBranch !== false) {
		await git(repo, ["remote", "set-head", "origin", "main"]);
	}
	const rt = createRuntime(run);
	rt.config.stateDir = stateDir;
	return { rt, dir, stateDir, repo, origin, now: Date.now() };
}

/** The values of a worker in the report of the prune. */
export interface WorkerOptions {
	/** The id of the worker. */
	id: string;
	/** The number of days since the worker ended. The default is 30. */
	finishedDaysAgo?: number;
	/** The messages of the commits that the worker makes. */
	commits?: string[];
	/** True when the worker leaves an uncommitted file behind. */
	uncommitted?: boolean;
}

/** Add a worker with a real worktree to the fixture. */
export async function addWorker(fixture: PruneFixture, options: WorkerOptions): Promise<Job> {
	const id = options.id;
	const path = join(fixture.stateDir, "worktrees", id);
	mkdirSync(join(fixture.stateDir, "worktrees"), { recursive: true });
	await git(fixture.repo, ["worktree", "add", "-b", `omp/worker/${id}`, path, "HEAD"]);
	for (const message of options.commits ?? []) {
		writeFileSync(join(path, `${id}-${message}.txt`), `${id} ${message}\n`, "utf8");
		await git(path, ["add", "-A"]);
		await git(path, ["commit", "-m", message]);
	}
	if (options.uncommitted) {
		writeFileSync(join(path, "uncommitted.txt"), "uncommitted\n", "utf8");
	}
	const sessionDir = join(fixture.stateDir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	const days = options.finishedDaysAgo ?? 30;
	const ended = fixture.now - days * DAY;
	const job: Job = {
		id,
		label: id,
		task: "task",
		cwd: path,
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		worktreePath: path,
		worktreeBranch: `omp/worker/${id}`,
		worktreeOrigin: fixture.repo,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(ended),
		status: "completed",
		paneId: null,
		runtime: "herdr",
		createdAt: ended,
		finishedAt: ended,
	};
	fixture.rt.jobs.set(id, job);
	return job;
}

/**
 * Add a worker that holds no worktree to the fixture.
 *
 * The worker ended long ago and it never had a worktree. The prune has
 * nothing to do with it.
 */
export function addWorklessWorker(fixture: PruneFixture, id: string): Job {
	const ended = fixture.now - 30 * DAY;
	const sessionDir = join(fixture.stateDir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	const job: Job = {
		id,
		label: id,
		task: "task",
		cwd: fixture.repo,
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(ended),
		status: "completed",
		paneId: null,
		runtime: "herdr",
		createdAt: ended,
		finishedAt: ended,
	};
	fixture.rt.jobs.set(id, job);
	return job;
}

/**
 * Put the commits of the worker into the target branch.
 *
 * The copy of the patch gets another sha, so the branch of the worker is not
 * merged for git. This is the state that a rebase merge leaves.
 */
export async function applyWorkerCommits(fixture: PruneFixture, id: string): Promise<void> {
	const sha = (await git(fixture.repo, ["rev-parse", `omp/worker/${id}`])).trim();
	await git(fixture.repo, ["cherry-pick", sha]);
	await git(fixture.repo, ["push", "origin", "main"]);
}

/** An event of a run that no owner handled. */
export function seedEvent(rt: WorkerRuntime, runId: string, eventId: string): void {
	createEvent(
		rt.openDb(),
		eventId,
		`key-${eventId}`,
		runId,
		"permission_request",
		"permission_request",
		JSON.stringify({ callId: "call-1", tool: "Bash" }),
		true,
		Date.now(),
	);
}

/** The tool that the extension registers. */
export function toolOf(rt: WorkerRuntime, register: (deps: ToolDeps) => void, name: string): FakeTool {
	const tools = new Map<string, FakeTool>();
	register({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set(name, tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get(name);
	assert.ok(tool, `the ${name} tool was not registered`);
	return tool;
}

/** One worker of the report of the prune. */
export interface ReportItem {
	workerId: string;
	reason: string;
}

/** The workers of one list of the report of the prune. */
export function itemsOf(value: unknown): ReportItem[] {
	assert.ok(Array.isArray(value), "the list of the report is missing");
	return value as ReportItem[];
}

/** Close the runtime and remove the files of the test. */
export function finish(fixture: PruneFixture): void {
	fixture.rt.closeDb();
}

/**
 * The helpers of the takeover tests.
 *
 * The tests need a runtime whose process table answers with a fixed table and
 * a host that records the takeover tool. The helpers live here, so the two
 * test files do not copy them.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import {
	acquireOwnership,
	beginRelease,
	commitRelease,
	type OwnerPhase,
	type Ownership,
	readOwnership,
} from "../extensions/lib/ownership.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerTakeoverTool } from "../extensions/worker-tools/takeover.ts";

export const OWN_PID = 500;
export const OLD_PID = 900;
export const THIRD_PID = 700;
export const OWN_START = "2026-10-23T01:00:00.000Z";
export const OLD_START = "2026-10-22T08:00:00.000Z";
export const THIRD_START = "2026-10-23T09:00:00.000Z";

/** The answers that the fake process table gives. */
export interface FakeTable {
	/** The start time of each process. An empty value means that the process is gone. */
	starts: Record<number, string>;
	/** The exit code of the command that reads a process. */
	code: number;
	/** The panes that the fake WezTerm reports. */
	panes: number[];
	/** The processes whose start time the table cannot read. */
	failFor?: number[];
	/** A hook that runs while the process table is read. */
	onProbe?: () => void;
}

/** The options of a fake runtime. */
export interface FakeOptions {
	/** Leave the start time of this process empty, like a session that just started. */
	withoutOwnStart?: boolean;
	/** Use this state directory. A second session reads the records of the first one. */
	stateDir?: string;
	/** The process of this session. A second session runs in another process. */
	ownProcess?: { id: number; startedAt: string };
}

/** A runtime whose process table and pane list come from the fake table. */
export function fakeRuntime(table: FakeTable, options: FakeOptions = {}): { rt: WorkerRuntime; dir: string } {
	const dir = options.stateDir ?? mkdtempSync(join(tmpdir(), "wt-takeover-"));
	const exec: RunFn = async (_bin, args) => {
		const command = args.join(" ");
		if (command.includes("Get-Process -Id")) {
			const match = /Get-Process -Id (\d+)/.exec(command);
			table.onProbe?.();
			const processId = match ? Number(match[1]) : 0;
			if (table.failFor?.includes(processId)) {
				return { code: 1, stdout: "", stderr: "no table" };
			}
			if (table.code !== 0) return { code: table.code, stdout: "", stderr: "no table" };
			const startedAt = match ? (table.starts[Number(match[1])] ?? "") : "";
			return { code: 0, stdout: startedAt, stderr: "" };
		}
		if (command.includes("list --format json")) {
			const panes = table.panes.map((pane_id) => ({ pane_id }));
			return { code: 0, stdout: JSON.stringify(panes), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.pollMs = 60_000;
	rt.processId = options.ownProcess?.id ?? OWN_PID;
	rt.processStartedAt = options.withoutOwnStart ? null : (options.ownProcess?.startedAt ?? OWN_START);
	return { rt, dir };
}

/** A worker that runs in a pane. */
export function makeJob(dir: string, id: string, overrides: Partial<Job> = {}): Job {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "running",
		paneId: 3,
		...overrides,
	} as Job;
}

/** A host that records the tool that the extension registers. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A zod stub that accepts every parameter object. */
export function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

/** Call the takeover tool for one worker. */
export async function takeOver(rt: WorkerRuntime, workerId: string) {
	const tools = new Map<string, FakeTool>();
	registerTakeoverTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("takeover", tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("takeover");
	if (!tool) throw new Error("the takeover tool was not registered");
	return tool.execute("t1", { workerId });
}

/** The owner of the task of a worker. */
export function ownerOf(rt: WorkerRuntime, jobId: string) {
	return readOwnership(rt.openDb(), taskKey(jobId)).owner;
}

/** The row of a task that another session owns. */
export function seedOwner(
	rt: WorkerRuntime,
	jobId: string,
	processId: number | null,
	startedAt: string | null,
) {
	acquireOwnership(rt.openDb(), taskKey(jobId), "session-old", processId, startedAt, 1000);
}

/**
 * The row of a task that the calling session owns.
 *
 * The phase decides what the row holds. The phase `active` is the state of a
 * running task. The phase `releasing` is the state of a task whose release
 * runs. The phase `released` is the state of a task whose release finished.
 */
export function seedOwnTask(
	rt: WorkerRuntime,
	jobId: string,
	phase: OwnerPhase,
	sessionId = "session-old",
): Ownership {
	const db = rt.openDb();
	const key = taskKey(jobId);
	acquireOwnership(db, key, sessionId, OWN_PID, OWN_START, 1000);
	if (phase !== "active") beginRelease(db, key, sessionId, 1, 1100);
	if (phase === "released") commitRelease(db, key, sessionId, 1, 1200);
	const owner = readOwnership(db, key).owner;
	if (!owner) throw new Error("the task has no owner row");
	return owner;
}

/**
 * The takeover of a task that the calling session owns in the given phase.
 *
 * The test gets the reply of the tool and the row that the call left.
 */
export async function ownTakeover(
	t: TestContext,
	phase: OwnerPhase,
	table: FakeTable = { starts: {}, code: 0, panes: [3] },
) {
	const { rt, job } = ownTaskCase(t, table, phase);
	const result = await takeOver(rt, job.id);
	return { result, owner: ownerOf(rt, job.id), job, rt };
}

/**
 * A runtime, a worker and a task that the calling session owns.
 *
 * The task holds the given phase. The test closes the runtime and removes
 * the directory when it ends.
 */
export function ownTaskCase(
	t: TestContext,
	table: FakeTable,
	phase: OwnerPhase,
): { rt: WorkerRuntime; dir: string; job: Job } {
	const { rt, dir } = fakeRuntime(table);
	rt.sessionId = "session-old";
	const job = makeJob(dir, "wz-1");
	rt.jobs.set(job.id, job);
	seedOwnTask(rt, job.id, phase);
	t.after(() => {
		rt.stopMonitor(job.id);
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	});
	return { rt, dir, job };
}

/** Close the runtime and remove the state directory of a test. */
export function finish(rt: WorkerRuntime, dir: string, jobId: string): void {
	rt.stopMonitor(jobId);
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

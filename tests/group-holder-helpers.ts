/**
 * The helpers of the group holder tests.
 *
 * The tests need a runtime with a fake WezTerm, a job record and a host that
 * records the cleanup tool. The helpers live here, so the test file keeps
 * its own behaviour.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { LifecycleDb } from "../extensions/lib/db.ts";
import { createGroup, type ResourceGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";

/** A worker record with the fields that the tests need. */
export function jobOf(id: string, overrides: Partial<Job> = {}): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: false,
		...freshRunState(0),
		status: "completed",
		paneId: 7,
		...overrides,
	};
}

/**
 * The fake WezTerm of the tests.
 *
 * The pane list answers with the given panes. The launch answers with a pane
 * id. The calls are recorded, so a test can see what ran.
 */
export function fakeWezterm(options: { panes?: unknown; listCode?: number } = {}): {
	exec: RunFn;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push(args);
		if (args.includes("list")) {
			const code = options.listCode ?? 0;
			return { code, stdout: code === 0 ? JSON.stringify(options.panes ?? []) : "", stderr: "" };
		}
		if (args.includes("split-pane") || args.includes("spawn")) {
			return { code: 0, stdout: "99", stderr: "" };
		}
		if (args.includes("get-text")) return { code: 0, stdout: "bypass permissions on", stderr: "" };
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

/** True when a call started a pane. */
export function launchedPane(calls: string[][]): boolean {
	return calls.some((args) => args.includes("split-pane") || args.includes("spawn"));
}

/** A tool that the fake host records. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, boolean: () => chain, object: () => chain } as never;
}

/** The cleanup tool of the extension, with the given runtime. */
export function cleanupTool(rt: WorkerRuntime): FakeTool {
	const tools = new Map<string, FakeTool>();
	registerCleanupTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("cleanup", tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("cleanup");
	if (!tool) throw new Error("the cleanup tool was not registered");
	return tool;
}

/** A session directory with a transcript in it. */
export function sessionDirOf(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return sessionDir;
}

/** The group of an id, which the test has created. */
export function groupOfId(db: LifecycleDb, id: string): ResourceGroup {
	const group = readGroup(db, id);
	if (!group) throw new Error(`the group ${id} does not exist`);
	return group;
}

/** A runtime with a database in a fresh directory that the test removes. */
export function runtimeFor(t: TestContext, exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-group-holder-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	t.after(() => {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	});
	return { rt, dir };
}

/** A task with a group that a holder holds. */
export function taskWith(
	t: TestContext,
	exec: RunFn,
): {
	rt: WorkerRuntime;
	db: LifecycleDb;
	sessionDir: string;
} {
	const { rt, dir } = runtimeFor(t, exec);
	const db = rt.openDb();
	const sessionDir = sessionDirOf(dir, "wz-task");
	createGroup(db, "grp-wz-task", sessionDir, 1000);
	return { rt, db, sessionDir };
}

/** A run that ended and holds a group. */
export function seedHolder(
	rt: WorkerRuntime,
	groupId: string,
	sessionDir: string,
	id: string,
	paneId: number | null,
): void {
	reserveExecution(rt.openDb(), groupId, id, 1001);
	const holder = jobOf(id, { sessionDir, paneId, paneClosed: false, status: "completed" });
	rt.jobs.set(holder.id, holder);
}

/** A run of the task that the test acts on. */
export function seedTarget(rt: WorkerRuntime, sessionDir: string, id: string): void {
	const target = jobOf(id, { sessionDir, paneId: null, status: "completed" });
	rt.jobs.set(target.id, target);
}

/** A group that a run holds, with a job of that run in the runtime. */
export function heldGroup(rt: WorkerRuntime, db: LifecycleDb, job: Job): ResourceGroup {
	const id = `grp-${job.id}`;
	createGroup(db, id, job.sessionDir, 1000);
	reserveExecution(db, id, job.id, 1001);
	rt.jobs.set(job.id, job);
	return groupOfId(db, id);
}

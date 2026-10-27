/**
 * The holder of a resource group that ended.
 *
 * A run keeps its group when its pane stays open after the run ends. A user
 * can close that pane by hand. A resume and a cleanup must then free the
 * group, because the pane that could write into the shared transcript is
 * gone.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LifecycleDb } from "../extensions/lib/db.ts";
import type * as GroupHolder from "../extensions/lib/group-holder.ts";
import { createGroup, type ResourceGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";

/**
 * The module under test.
 *
 * A static import cannot work on the branch that does not have the module
 * yet. A missing module stops the whole file from loading, so the other
 * tests could not run and fail on their own behaviour.
 */
async function loadHolder(): Promise<typeof GroupHolder> {
	return await import("../extensions/lib/group-holder.ts");
}

/** A runtime with a database in a fresh directory. */
function freshRuntime(exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-group-holder-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** A worker record with the fields that these tests need. */
function jobOf(id: string, overrides: Partial<Job> = {}): Job {
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
 * The fake WezTerm of these tests.
 *
 * The pane list answers with the given panes. The launch answers with a pane
 * id. The calls are recorded, so a test can see what ran.
 */
function fakeWezterm(options: { panes?: unknown; listCode?: number } = {}): {
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
function launchedPane(calls: string[][]): boolean {
	return calls.some((args) => args.includes("split-pane") || args.includes("spawn"));
}

/** A tool that the fake host records. */
interface FakeTool {
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
function cleanupTool(rt: WorkerRuntime): FakeTool {
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
	assert.ok(tool, "the cleanup tool was not registered");
	return tool;
}

/** A session directory with a transcript in it. */
function sessionDirOf(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return sessionDir;
}

/** The group of an id, which the test has created. */
function groupOfId(db: LifecycleDb, id: string): ResourceGroup {
	const group = readGroup(db, id);
	assert.ok(group, `the group ${id} does not exist`);
	return group;
}

test("the decision names one result for every state of the holder", async () => {
	const { decideHolder } = await loadHolder();
	const ended = jobOf("wz-1");
	const closed = jobOf("wz-2", { paneClosed: true });
	const withoutPane = jobOf("wz-3", { paneId: null });
	const active = jobOf("wz-4", { status: "running" });

	assert.equal(decideHolder(ended, "gone"), "release");
	assert.equal(decideHolder(closed, null), "release");
	assert.equal(decideHolder(withoutPane, null), "release");
	assert.equal(decideHolder(ended, "present"), "keep-pane-open");
	assert.equal(decideHolder(ended, "unknown"), "keep-pane-unknown");
	assert.equal(decideHolder(active, "gone"), "keep");
	assert.equal(decideHolder(undefined, null), "keep");
});

test("the holder of an ended run frees its group when its pane is gone", async () => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [] });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "wz-1", 1001);
		const job = jobOf("wz-1", { paneId: 7, paneClosed: false });
		rt.jobs.set(job.id, job);

		const result = await freeEndedHolder(rt, groupOfId(db, "grp-1"));

		assert.equal(result, null);
		assert.equal(readGroup(db, "grp-1")?.executionHolder, null);
		assert.equal(readGroup(db, "grp-1")?.executionState, "free");
		assert.equal(job.paneClosed, true);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the holder of an ended run keeps its group while its pane is open", async () => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [{ pane_id: 7, tab_id: 1, window_id: 1 }] });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "wz-1", 1001);
		const job = jobOf("wz-1", { paneId: 7, paneClosed: false });
		rt.jobs.set(job.id, job);

		const result = await freeEndedHolder(rt, groupOfId(db, "grp-1"));

		assert.equal(
			result,
			"The resources of this task are held by run wz-1. Its pane 7 is still open. Close pane 7, then try again.",
		);
		assert.equal(readGroup(db, "grp-1")?.executionHolder, "wz-1");
		assert.equal(job.paneClosed, false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the holder of an ended run keeps its group when the pane list fails", async () => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [], listCode: 1 });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "wz-1", 1001);
		const job = jobOf("wz-1", { paneId: 7, paneClosed: false });
		rt.jobs.set(job.id, job);

		const result = await freeEndedHolder(rt, groupOfId(db, "grp-1"));

		assert.equal(result, "The pane list cannot be read, so the state of pane 7 is unknown. Try again.");
		assert.equal(readGroup(db, "grp-1")?.executionHolder, "wz-1");
		assert.equal(job.paneClosed, false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an active holder keeps its group", async () => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [] });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "wz-1", 1001);
		const job = jobOf("wz-1", { status: "running", paneId: 7, paneClosed: false });
		rt.jobs.set(job.id, job);

		const result = await freeEndedHolder(rt, groupOfId(db, "grp-1"));

		assert.equal(result, null);
		assert.equal(readGroup(db, "grp-1")?.executionHolder, "wz-1");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a holder that this process does not know keeps its group", async () => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [] });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "wz-1", 1001);

		const result = await freeEndedHolder(rt, groupOfId(db, "grp-1"));

		assert.equal(result, null);
		assert.equal(readGroup(db, "grp-1")?.executionHolder, "wz-1");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume takes the group of a source run whose pane was closed by hand", async () => {
	const { exec, calls } = fakeWezterm({ panes: [] });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-src");
		createGroup(db, "grp-wz-src", sessionDir, 1000);
		reserveExecution(db, "grp-wz-src", "wz-src", 1001);
		const source = jobOf("wz-src", {
			sessionDir,
			sessionFile: join(sessionDir, "a.jsonl"),
			paneId: 7,
			paneClosed: false,
			status: "completed",
		});
		rt.jobs.set(source.id, source);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-new" });

		assert.equal(resumed.status, "running", `the resume failed: ${resumed.error}`);
		assert.equal(readGroup(db, "grp-wz-src")?.executionHolder, "wz-new");
		assert.equal(source.paneClosed, true);
		assert.equal(launchedPane(calls), true);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the cleanup of a task whose holder ended with its pane gone goes on", async () => {
	const { exec } = fakeWezterm({ panes: [] });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-task");
		createGroup(db, "grp-wz-task", sessionDir, 1000);
		reserveExecution(db, "grp-wz-task", "wz-hold", 1001);
		const holder = jobOf("wz-hold", { sessionDir, paneId: 7, paneClosed: false, status: "completed" });
		rt.jobs.set(holder.id, holder);
		const target = jobOf("wz-task", { sessionDir, paneId: null, status: "completed" });
		rt.jobs.set(target.id, target);

		const result = await cleanupTool(rt).execute("t1", { workerId: "wz-task" });

		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /transcript directory removed/);
		assert.equal(existsSync(sessionDir), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

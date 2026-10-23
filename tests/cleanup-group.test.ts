/**
 * The cleanup of a resumed run.
 *
 * A resumed run shares the transcript directory of its source run. The
 * cleanup must find the group of that directory, so a run that still holds
 * the group keeps the directory alive.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";

/** A host that records the tools that the extension registers. */
interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
		extra?: unknown,
		fifth?: unknown,
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

/** A runtime with a database in a fresh directory. */
function freshRuntime(exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-cleanup-group-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** A session directory with a transcript in it. */
function sessionDirOf(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return sessionDir;
}

/** A finished run that shares the session directory of its source run. */
function finishedJob(id: string, sessionDir: string): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
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
		...freshRunState(0),
		status: "completed",
		paneId: null,
	};
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

test("the cleanup of a resumed run refuses while another run holds the group", async () => {
	const { rt, dir } = freshRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-a");
		createGroup(db, "grp-wz-a", sessionDir, 1000);
		// A run of another session holds the group. Its job is not in the
		// registry of this runtime, so the group holds the truth.
		reserveExecution(db, "grp-wz-a", "wz-c", 1001);
		const job = finishedJob("wz-b", sessionDir);
		rt.jobs.set(job.id, job);

		const result = await cleanupTool(rt).execute("t1", { workerId: "wz-b" });

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"The resources of worker wz-b are used by run wz-c. Cancel that run first.",
		);
		assert.equal(existsSync(sessionDir), true);
		assert.equal(readGroup(db, "grp-wz-a")?.executionHolder, "wz-c");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the cleanup of a first run refuses while another run holds the group", async () => {
	const { rt, dir } = freshRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-a");
		createGroup(db, "grp-wz-a", sessionDir, 1000);
		reserveExecution(db, "grp-wz-a", "wz-b", 1001);
		const job = finishedJob("wz-a", sessionDir);
		rt.jobs.set(job.id, job);

		const result = await cleanupTool(rt).execute("t1", { workerId: "wz-a" });

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"The resources of worker wz-a are used by run wz-b. Cancel that run first.",
		);
		assert.equal(existsSync(sessionDir), true);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the cleanup of a run without a group deletes the transcript", async () => {
	const { rt, dir } = freshRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	try {
		const sessionDir = sessionDirOf(dir, "wz-old");
		const job = finishedJob("wz-old", sessionDir);
		rt.jobs.set(job.id, job);

		const result = await cleanupTool(rt).execute("t1", { workerId: "wz-old" });

		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /transcript directory removed/);
		assert.equal(existsSync(sessionDir), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

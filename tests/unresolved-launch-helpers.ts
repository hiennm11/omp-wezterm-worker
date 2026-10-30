/**
 * The helpers of the tests of an unresolved launch.
 *
 * The tests need a database, a runtime and a host that records the tools of
 * the extension. The helpers live here, so the test file holds only the
 * behaviour that it checks.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markIssued, readAttempt, reserveAttempt } from "../extensions/lib/attempts.ts";
import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";

/** The session that calls the tool. */
export const OWN = "session-new";

/** The session that holds the task. */
export const OTHER = "session-old";

/** A database in a fresh directory. */
export function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-unresolved-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** The ownership row of a task that a session owns. */
export function seedOwner(db: LifecycleDb, jobId: string, sessionId: string): void {
	acquireOwnership(db, taskKey(jobId), sessionId, 500, "2026-10-23T01:00:00.000Z", 1000);
}

/** The state of an attempt, or null when the id is unknown. */
export function stateOf(db: LifecycleDb, id: string): string | null {
	return readAttempt(db, id)?.state ?? null;
}

/** An attempt that a crash left open. */
export function seedOpenAttempt(db: LifecycleDb, jobId: string, attemptId: string): void {
	reserveAttempt(db, attemptId, jobId, 1000);
	markIssued(db, attemptId, 1001);
}

/** A runtime with an empty state directory. */
export function fakeRuntime(): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-unresolved-rt-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** A worker that runs in a pane. */
export function makeJob(dir: string, id: string): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join(dir, "sessions", id),
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
	} as Job;
}

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, boolean: () => chain, object: () => chain } as never;
}

/** A tool that the fake host records. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
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

/** The parameters of a resolution. */
export function resolveParams(eventId: string, resolution: string): Record<string, unknown> {
	return {
		workerId: "wz-1",
		eventId,
		resolution,
		evidenceNote: "The pane of the worker is gone.",
	};
}

/** Close the runtime and remove the state directory of a test. */
export function closeRuntime(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

/** Close the database and remove the state directory of a test. */
export function closeDb(db: LifecycleDb, dir: string): void {
	db.close();
	rmSync(dir, { recursive: true, force: true });
}

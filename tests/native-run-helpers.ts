/**
 * The helpers of the tests of a native run.
 *
 * A native run is a Claude Code run. Its job has the backend `claude` and a
 * native session id. The tests need a runtime whose pane list comes from the
 * test, a native job, an event of the run and a way to register the tools.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { type RunFn, run } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";

/** A tool that the fake host records. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
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

/**
 * A runtime with a database in a fresh directory.
 *
 * The pane list holds the given pane ids. The list answers the way the
 * WezTerm CLI answers it.
 */
export function nativeRuntime(panes: number[] = []): {
	rt: WorkerRuntime;
	dir: string;
	sessionDir: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "wt-native-run-"));
	const exec: RunFn = async (_bin, args) => {
		const command = args.join(" ");
		if (command.includes("list --format json")) {
			const listing = panes.map((pane_id) => ({ pane_id }));
			return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return { rt, dir, sessionDir };
}

/** A finished native run with a session directory. */
export function nativeJob(sessionDir: string, overrides: Partial<Job> = {}): Job {
	return {
		id: "wz-1",
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
		...freshRunState(Date.now()),
		status: "completed",
		paneId: null,
		backend: "claude",
		nativeSessionId: "sess-1",
		...overrides,
	} as Job;
}

/** An actionable event of a run. */
export function seedPermissionEvent(rt: WorkerRuntime, runId: string, eventId: string): void {
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

/** The owner of the task of a worker. */
export function seedOwner(rt: WorkerRuntime, jobId: string, sessionId: string): void {
	acquireOwnership(rt.openDb(), taskKey(jobId), sessionId, 500, "2026-10-29T08:00:00.000Z", Date.now());
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

/** The number of the handling rows of an event. */
export function handlingRows(rt: WorkerRuntime, eventId: string): number {
	const row = rt
		.openDb()
		.handle.prepare("SELECT COUNT(*) AS n FROM event_handling WHERE event_id = ?")
		.get(eventId) as { n: number };
	return Number(row.n);
}

/** A real git repository at the given path. */
export async function gitRepo(path: string): Promise<string> {
	const result = await run("git", ["init", path]);
	if (result.code !== 0) throw new Error(`git init failed: ${result.stderr}`);
	return path;
}

/** Close the runtime and remove the state directory of a test. */
export function finish(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

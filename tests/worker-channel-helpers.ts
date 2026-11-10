/**
 * The helpers of the worker channel tests.
 *
 * The tests need a runtime with a channel and a host that records the
 * channel tools. The helpers live here, so the test files do not copy them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { writeRunContext } from "../extensions/lib/worker-context.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";

/** The session that calls the tool. */
export const OWN = "session-new";

/** A tool that the extension registers. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
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

/** A runtime whose communication check is off. */
export function fakeRuntime(): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-channel-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = dir;
	rt.config.commsStandard = { mode: "off", minScore: 80 };
	rt.sessionId = OWN;
	return { rt, dir };
}

/** The session directory of a worker, with the context of its run. */
export function workerSession(dir: string, id: string, backend: "omp" | "claude" = "omp"): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeRunContext(sessionDir, {
		runId: id,
		sourceRunId: null,
		resourceGroup: `grp-${id}`,
		backend,
	});
	return sessionDir;
}

/** The owner of the task of a worker. */
export function seedOwner(rt: WorkerRuntime, jobId: string, sessionId: string): void {
	acquireOwnership(rt.openDb(), taskKey(jobId), sessionId, 900, "2026-11-09T08:00:00.000Z", 1000);
}

/** The worker tool that the extension registers. */
export function workerToolOf(rt: WorkerRuntime, register: (deps: ToolDeps) => void, name: string): FakeTool {
	register({ pi: { zod: fakeZod() } as never, rt, deliver: () => undefined });
	const tool = rt.workerTools.get(name);
	assert.ok(tool, `the ${name} tool was not registered`);
	return tool as unknown as FakeTool;
}

/** The main tool that the extension registers. */
export function mainToolOf(rt: WorkerRuntime, register: (deps: ToolDeps) => void, name: string): FakeTool {
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

/** Run a function with the environment of a worker. */
export async function asWorker<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.OMP_WORKER_SESSION_DIR;
	process.env.OMP_WORKER_SESSION_DIR = sessionDir;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.OMP_WORKER_SESSION_DIR;
		else process.env.OMP_WORKER_SESSION_DIR = previous;
	}
}

/** Close the runtime and remove the state directory of a test. */
export function finish(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

/**
 * The helpers of the tests of the takeover of a Codex worker.
 *
 * The tests need a runtime whose process table answers like the machine, a
 * Codex worker that runs, and the release and takeover tools. The helpers
 * live here, so the two test files do not copy them.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexIdentity, Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { loadRuns } from "../extensions/lib/runs.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import { registerReleaseTool } from "../extensions/worker-tools/release.ts";
import { type CodexFake, type CodexFakeOptions, codexFake } from "./codex-spawn-helpers.ts";
import { type FakeTool, fakeZod } from "./takeover-helpers.ts";

/** The id of the worker of the tests. */
export const WORKER = "wz-codex-takeover";

/** The thread of the worker of the tests. */
export const THREAD = "thread-1";

/** The turn that the app server of the tests still runs. */
export const OPEN_TURN = "turn-open";

/** The session that owns the worker first. */
export const FIRST = "session-first";

/** The session that takes the worker over. */
export const SECOND = "session-second";

/** The pane of the app server of the tests. */
export const SERVER_PANE = 11;

/** The pane of the TUI of the tests. */
export const TUI_PANE = 12;

/** The options of the fake of the tests. */
function options(overrides: CodexFakeOptions = {}): CodexFakeOptions {
	return { openTurnId: OPEN_TURN, ...overrides };
}

/**
 * A fake runtime that reads and writes the state directory of a test.
 *
 * The processes of the machine come from the given rows. A session that
 * takes a worker over must see the app server of that worker.
 */
export function fakeIn(dir: string, seedProcesses: CodexFakeOptions["seedProcesses"] = []): CodexFake {
	const fake = codexFake(options({ seedProcesses }));
	fake.rt.config.stateDir = dir;
	fake.panes.add(SERVER_PANE);
	fake.panes.add(TUI_PANE);
	return fake;
}

/** The row of the process table that holds the app server of a worker. */
export function serverRow(identity: CodexIdentity): { pid: number; name: string; commandLine: string } {
	return {
		pid: identity.serverPid ?? 0,
		name: "codex.exe",
		commandLine: `"C:/fake/codex.exe" app-server --listen ws://127.0.0.1:${identity.port}`,
	};
}

/** The release tool of the extension, with the given runtime. */
export function releaseTool(rt: WorkerRuntime): FakeTool {
	const tools = new Map<string, FakeTool>();
	registerReleaseTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("release", tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("release");
	assert.ok(tool, "the release tool was not registered");
	return tool;
}

/**
 * Start a Codex worker in a pane of the fake.
 *
 * The session owns the task of the worker, so a release of that session can
 * move the authority.
 */
export async function spawnFirst(fake: CodexFake): Promise<Job> {
	fake.rt.sessionId = FIRST;
	fake.rt.processId = 501;
	fake.rt.processStartedAt = "2026-10-23T01:00:00.000Z";
	const job = await spawnCodexWorker(
		fake.rt,
		{ jobId: WORKER, task: "Wait for 60 seconds and then report.", cwd: fake.dir },
		{ connect: fake.connect, serverWaitMs: 100 },
	);
	assert.equal(job.status, "running", `the worker did not start: ${job.error ?? "no reason"}`);
	acquireOwnership(
		fake.rt.openDb(),
		taskKey(job.id),
		FIRST,
		fake.rt.processId,
		fake.rt.processStartedAt,
		Date.now(),
	);
	fake.rt.persist();
	return job;
}

/**
 * A second session that reads the worker of the state directory.
 *
 * The session reads the worker from the database, so the test also proves
 * that the identity of the worker survives the write of the first session.
 */
export function secondSession(fake: CodexFake): Job {
	fake.rt.sessionId = SECOND;
	fake.rt.processId = 502;
	fake.rt.processStartedAt = "2026-10-23T02:00:00.000Z";
	const { alive } = loadRuns(fake.rt.openDb());
	const job = alive.find((row) => row.id === WORKER);
	assert.ok(job, "the second session reads no worker");
	fake.rt.jobs.set(job.id, job);
	return job;
}

/** A state directory of a test. */
export function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
}

/** Close the runtimes of a test and remove its directory. */
export async function cleanup(dir: string, ...fakes: Array<CodexFake | null>): Promise<void> {
	for (const fake of fakes) {
		if (!fake) continue;
		await fake.closeBridges();
		fake.rt.closeDb();
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

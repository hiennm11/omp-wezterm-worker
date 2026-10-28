/**
 * The helpers of the re-attachment tests.
 *
 * The tests need a runtime whose pane list comes from the test, a native
 * worker with a session directory and a way to send an observation to a
 * bridge. The helpers live here, so the test file holds only the tests.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** A runtime whose pane list comes from the test and whose poll runs by hand. */
export function fakeRuntime(stateDir: string, panes: number[]): { rt: WorkerRuntime; tick: () => void } {
	const exec: RunFn = async (_bin, args) => {
		if (args.join(" ").includes("list --format json")) {
			const listing = panes.map((pane_id) => ({ pane_id }));
			return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = stateDir;
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, tick: () => tick() };
}

/** A running native worker with a session directory. */
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
		status: "running",
		paneId: 7,
		backend: "claude",
		nativeSessionId: "sess-1",
		...overrides,
	} as Job;
}

/** A state directory with a session directory inside it. */
export function makeDirs(): { dir: string; sessionDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wz-reattach-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	return { dir, sessionDir };
}

/** Send one observation to a bridge and return the status code. */
export async function postObservation(
	url: string,
	token: string,
	source: string,
	payload: unknown,
): Promise<number> {
	const response = await fetch(`${url}/observations`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ backend: "claude", runId: "wz-1", sessionId: null, source, payload }),
	});
	return response.status;
}

/** Let the pending work of the monitor finish. The wait has no duration. */
export async function flush(turns: number): Promise<void> {
	for (let step = 0; step < turns; step += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

/** Wait for the monitor to deliver the result of the worker. */
export async function delivered(notified: PromiseWithResolvers<void>): Promise<void> {
	await Promise.race([notified.promise, flush(50)]);
}

/** Close the bridges, the database and the directory of a test. */
export async function cleanup(rt: WorkerRuntime, dir: string): Promise<void> {
	await Promise.all([...rt.bridges.values()].map((bridge) => bridge.close()));
	rt.bridges.clear();
	rt.claudeStates.clear();
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

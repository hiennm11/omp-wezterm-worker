/**
 * The helpers of the tests of the report reminder.
 *
 * The tests need a worker, a runtime and a clock. The helpers live here, so
 * the test files do not copy them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eventsOfRun } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** The time that the tests start at. */
export const START = 1_000_000;

/** A user message that starts a cycle. */
export const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

/** An assistant message that ends its turn with text. */
export const ANSWER = {
	type: "message",
	id: "e1",
	message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
};

/** A running worker with a session directory. */
export function runningJob(sessionDir: string): Job {
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
		...freshRunState(START),
		status: "running",
		paneId: "w1:p7",
		runtime: "herdr",
	};
}

/** A runtime whose report poll runs only when the test calls it. */
export function fakeRuntime(stateDir: string): {
	rt: WorkerRuntime;
	tick: () => void;
	prompts: string[];
	wakes: string[];
} {
	const prompts: string[] = [];
	const wakes: string[] = [];
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
	rt.config.stateDir = stateDir;
	rt.herdr = async (args) => {
		if (args[0] === "agent" && args[1] === "prompt") prompts.push(args[3] ?? "");
		return { code: 0, stdout: "", stderr: "" };
	};
	rt.sendToMainSession = (text) => {
		wakes.push(text);
		return "sendUserMessage";
	};
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, tick: () => tick(), prompts, wakes };
}

/** A clock that the test moves by hand. */
export function fakeClock(): { advance: (ms: number) => void; restore: () => void } {
	const real = Date.now;
	let current = START;
	Date.now = () => current;
	return {
		advance: (ms) => {
			current += ms;
		},
		restore: () => {
			Date.now = real;
		},
	};
}

/** Let the pending promises of the runtime settle. */
export async function flush(): Promise<void> {
	for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/** A report that a worker sends when it needs a decision of the owner. */
export function needsInputReport(sessionDir: string, runId: string): void {
	appendReport(sessionDir, {
		runId,
		cycleId: null,
		state: "needs_input",
		result: null,
		dependency: null,
		resumeCondition: null,
		needs: "The owner must answer the question of the task.",
		detail: null,
	});
}

/** The events of a run that carry the given condition. */
export function eventsWithCondition(rt: WorkerRuntime, jobId: string, condition: string) {
	return eventsOfRun(rt.openDb(), jobId).filter((event) => event.condition === condition);
}

/** A fresh state directory for a test of the reminder. */
export function freshStateDir(): string {
	return mkdtempSync(join(tmpdir(), "wz-reminder-"));
}

/** Remove a state directory of a test. */
export function removeStateDir(stateDir: string): void {
	rmSync(stateDir, { recursive: true, force: true });
}

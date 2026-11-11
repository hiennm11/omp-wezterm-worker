/**
 * The reminder for a worker that ends a cycle without a report.
 *
 * The extension reminds the worker first. It wakes the owner only when the
 * reminder fails. The tests use a fake clock, so no test waits for a real
 * minute.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CYCLE_SETTLE_MS, type CycleState } from "../extensions/lib/cycle-state.ts";
import { eventsOfRun, readHandling } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import {
	MISSING_REPORT_GRACE_MS,
	missingReportAction,
	reminderText,
} from "../extensions/lib/report-reminder.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { writeTranscript } from "./execution-helpers.ts";

const START = 1_000_000;

/** A user message that starts a cycle. */
const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

/** An assistant message that ends its turn with text. */
const ANSWER = {
	type: "message",
	id: "e1",
	message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
};

/** A cycle state that closed at the given time. */
function closedCycle(closedSince: number, evidenceId = "e0"): CycleState {
	return {
		evidenceId,
		terminalTurn: 1,
		closed: true,
		thinking: false,
		closedSince,
		lastEntryId: "e1",
		lastEntryAt: closedSince,
	};
}

/** A running worker with a session directory. */
function runningJob(sessionDir: string): Job {
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
function fakeRuntime(stateDir: string): {
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
function fakeClock(): { advance: (ms: number) => void; restore: () => void } {
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
async function flush(): Promise<void> {
	for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/** A report that a worker sends when it needs a decision of the owner. */
function needsInputReport(sessionDir: string, runId: string): void {
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
function eventsWithCondition(rt: WorkerRuntime, jobId: string, condition: string) {
	return eventsOfRun(rt.openDb(), jobId).filter((event) => event.condition === condition);
}

test("a terminal cycle without a report gives one reminder after the settle time", () => {
	const state = closedCycle(START);
	assert.equal(missingReportAction(state, null, START + CYCLE_SETTLE_MS - 1), "wait");
	assert.equal(missingReportAction(state, null, START + CYCLE_SETTLE_MS), "nudge");
});

test("many ticks give exactly one reminder for the cycle", () => {
	const state = closedCycle(START);
	let reminder = null;
	let nudges = 0;
	for (let step = 0; step < 40; step += 1) {
		const now = START + CYCLE_SETTLE_MS + step * 1_000;
		const action = missingReportAction(state, reminder, now);
		if (action === "nudge") {
			nudges += 1;
			reminder = { evidenceId: state.evidenceId, sentAt: now };
		}
	}
	assert.equal(nudges, 1, "the cycle gets one reminder");
});

test("a thinking cycle and a cycle with an open call give no reminder", () => {
	const thinking = { ...closedCycle(START), closed: false, thinking: true };
	assert.equal(missingReportAction(thinking, null, START + CYCLE_SETTLE_MS), "wait");
	const open = { ...closedCycle(START), closed: false, thinking: false };
	assert.equal(missingReportAction(open, null, START + CYCLE_SETTLE_MS), "wait");
});

test("a cycle that holds a reminder waits for the grace and then wakes", () => {
	const state = closedCycle(START);
	const reminder = { evidenceId: state.evidenceId, sentAt: START + CYCLE_SETTLE_MS };
	assert.equal(missingReportAction(state, reminder, START + CYCLE_SETTLE_MS), "wait");
	assert.equal(
		missingReportAction(state, reminder, START + CYCLE_SETTLE_MS + MISSING_REPORT_GRACE_MS - 1),
		"wait",
	);
	assert.equal(
		missingReportAction(state, reminder, START + CYCLE_SETTLE_MS + MISSING_REPORT_GRACE_MS),
		"wake",
	);
});

test("a new cycle gets its own reminder", () => {
	const state = closedCycle(START, "e2");
	const reminder = { evidenceId: "e0", sentAt: START };
	assert.equal(missingReportAction(state, reminder, START + CYCLE_SETTLE_MS), "nudge");
});

test("the reminder text names the report tool", () => {
	assert.match(reminderText("wz-1"), /wezterm_worker_report/);
	assert.match(reminderText("wz-1"), /without a report/);
});

test("the monitor sends one reminder and wakes the owner only after the grace", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reminder-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const clock = fakeClock();
	const { rt, tick, prompts, wakes } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, ANSWER]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		monitorJob(rt, job, () => {});

		tick();
		await flush();
		assert.equal(prompts.length, 0, "the cycle still settles");
		assert.equal(wakes.length, 0, "the owner sleeps while the cycle settles");

		clock.advance(CYCLE_SETTLE_MS);
		tick();
		await flush();
		assert.equal(prompts.length, 1, "the worker gets one reminder");
		assert.match(prompts[0] ?? "", /wezterm_worker_report/);
		assert.equal(wakes.length, 0, "the owner does not wake yet");
		assert.equal(eventsWithCondition(rt, job.id, "missing_report").length, 0, "no event yet");

		clock.advance(MISSING_REPORT_GRACE_MS);
		tick();
		await flush();
		assert.equal(eventsWithCondition(rt, job.id, "missing_report").length, 1, "the event comes");
		assert.equal(wakes.length, 1, "the owner wakes once");

		clock.advance(MISSING_REPORT_GRACE_MS);
		tick();
		await flush();
		assert.equal(prompts.length, 1, "a later tick sends no second reminder");
		assert.equal(wakes.length, 1, "the owner wakes once");
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a report before the end of the grace gives no wake", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reminder-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const clock = fakeClock();
	const { rt, tick, prompts, wakes } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, ANSWER]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		monitorJob(rt, job, () => {});

		tick();
		await flush();
		clock.advance(CYCLE_SETTLE_MS);
		tick();
		await flush();
		assert.equal(prompts.length, 1, "the worker gets the reminder");

		needsInputReport(sessionDir, job.id);
		clock.advance(MISSING_REPORT_GRACE_MS - 1_000);
		tick();
		await flush();
		assert.equal(wakes.length, 0, "the report keeps the owner asleep");
		assert.equal(eventsWithCondition(rt, job.id, "missing_report").length, 0, "no event comes");
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a report after the wake resolves the event of the cycle", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reminder-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const clock = fakeClock();
	const { rt, tick, wakes } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, ANSWER]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		monitorJob(rt, job, () => {});

		tick();
		await flush();
		clock.advance(CYCLE_SETTLE_MS);
		tick();
		await flush();
		clock.advance(MISSING_REPORT_GRACE_MS);
		tick();
		await flush();
		assert.equal(wakes.length, 1, "the owner wakes");
		const event = eventsWithCondition(rt, job.id, "missing_report")[0];
		assert.ok(event, "the event of the cycle exists");

		needsInputReport(sessionDir, job.id);
		tick();
		await flush();
		assert.equal(readHandling(rt.openDb(), event.id)?.disposition, "accepted", "the event resolves");
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a worker with an unknown runtime gets no reminder", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reminder-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const clock = fakeClock();
	const { rt, tick, prompts, wakes } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, ANSWER]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		job.runtime = null;
		rt.jobs.set(job.id, job);
		monitorJob(rt, job, () => {});

		tick();
		await flush();
		clock.advance(CYCLE_SETTLE_MS);
		tick();
		await flush();
		assert.equal(prompts.length, 0, "no reminder reaches a worker with an unknown runtime");
		assert.equal(wakes.length, 1, "the owner wakes as it does today");
		assert.match(rt.errors.join("\n"), /runtime of worker wz-1 is unknown/);
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a restart sends no second reminder", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reminder-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const clock = fakeClock();
	const { rt, tick, prompts } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, ANSWER]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		monitorJob(rt, job, () => {});
		tick();
		await flush();
		clock.advance(CYCLE_SETTLE_MS);
		tick();
		await flush();
		assert.equal(prompts.length, 1, "the worker gets the reminder");

		// A restart loads the job from the database. The reminder rides with it.
		const restored = { ...job, missingReportReminder: job.missingReportReminder };
		rt.jobs.set(restored.id, restored);
		monitorJob(rt, restored, () => {});
		tick();
		await flush();
		assert.equal(prompts.length, 1, "the restart sends no reminder");
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

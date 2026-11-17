/**
 * The rate limit of a Claude Code worker.
 *
 * A Claude Code worker that hits the usage limit of its account raises the
 * event `rate_limited`. The run stays `running`. The owner decides to cancel
 * the worker or to wait. A newer turn resolves the event.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyObservation, type ClaudeRunState, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { eventsOfRun, pendingEvents, type WorkerEvent } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** The row of an assistant message that failed with a rate limit. */
const RATE_LIMIT_ROW = JSON.stringify({
	type: "assistant",
	error: "rate_limit",
	isApiErrorMessage: true,
	apiErrorStatus: 429,
	quotaLimits: {
		status: "rejected",
		resetsAt: 1792135800,
		rateLimitType: "five_hour",
	},
});

/** The row of an assistant message that failed with another error. */
const OTHER_ERROR_ROW = JSON.stringify({
	type: "assistant",
	error: "invalid_request",
	isApiErrorMessage: true,
	apiErrorStatus: 400,
});

/** A runtime whose polls run only when the test calls them. */
function fakeRuntime(stateDir: string): { rt: WorkerRuntime; tick: () => void } {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
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

/** A running native worker. */
function nativeJob(sessionDir: string): Job {
	const launchedAt = Date.now() - 61_000;
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
		...freshRunState(launchedAt),
		status: "running",
		paneId: "w1:p7",
		runtime: "herdr",
		backend: "claude",
		startedAt: launchedAt,
	};
}

/**
 * Wait for the read of the monitor.
 *
 * The read of the transcript is a promise. The test waits for the end of the
 * current turn of the event loop, so the promise of the read settles.
 */
async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/** A home directory of a test with a transcript of a Claude session. */
interface Fixture {
	/** The home that the reader uses. */
	home: string;
	/** The path of the transcript of the session. */
	transcript: string;
}

/**
 * A home with a transcript that holds the given rows.
 *
 * The function sets the home of the process, so the reader of the owner uses
 * this home and not the home of the user.
 */
function fixtureWith(rows: string[], body = ""): Fixture {
	const home = mkdtempSync(join(tmpdir(), "wz-home-"));
	const projects = join(home, ".claude", "projects", "C--repo");
	mkdirSync(projects, { recursive: true });
	const transcript = join(projects, "session-1.jsonl");
	writeFileSync(transcript, `${body}${rows.join("\n")}\n`);
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	return { home, transcript };
}

/** The observation of a turn that failed. */
function failedTurn(transcript: string, turnId = "turn-1") {
	return {
		backend: "claude" as const,
		runId: "wz-1",
		sessionId: "session-1",
		source: "turn.complete",
		payload: { turnId, reason: "error", transcriptPath: transcript },
	};
}

/** The observation of a turn that starts. */
function startedTurn(turnId = "turn-2") {
	return {
		backend: "claude" as const,
		runId: "wz-1",
		sessionId: "session-1",
		source: "turn.start",
		payload: { turnId },
	};
}

/** Run the monitor of a worker with the given observations. */
async function runMonitor(
	observations: unknown[],
	fixture: Fixture,
): Promise<{ rt: WorkerRuntime; tick: () => void; events: WorkerEvent[]; state: ClaudeRunState }> {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-limit-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir);
	const job = nativeJob(sessionDir);
	const state = createClaudeRunState(job.id);
	rt.jobs.set(job.id, job);
	rt.claudeStates.set(job.id, state);
	monitorNativeJob(rt, job, () => undefined);
	for (const observation of observations) {
		applyObservation(state, observation as never);
	}
	tick();
	await settle();
	return { rt, tick, events: eventsOfRun(rt.openDb(), job.id), state };
}

test("a failed turn with a rate limit raises one event", async () => {
	const fixture = fixtureWith([RATE_LIMIT_ROW]);
	try {
		const { rt, events } = await runMonitor([failedTurn(fixture.transcript)], fixture);
		assert.equal(events.length, 1, "the rate limit raises one event");
		assert.equal(events[0]?.condition, "rate_limited");
		assert.equal(events[0]?.actionable, true);
		const payload = JSON.parse(events[0]?.payload ?? "{}");
		assert.equal(payload.resetsAt, 1792135800000, "the reset time is in milliseconds");
		assert.equal(payload.rateLimitType, "five_hour");
		assert.equal(payload.apiErrorStatus, 429);
		rt.closeDb();
	} finally {
		rmSync(fixture.home, { recursive: true, force: true });
	}
});

test("a failed turn without quota limits raises the event without a reset time", async () => {
	const row = JSON.stringify({
		type: "assistant",
		error: "rate_limit",
		isApiErrorMessage: true,
		apiErrorStatus: 429,
		quotaLimits: null,
	});
	const fixture = fixtureWith([row]);
	try {
		const { rt, events } = await runMonitor([failedTurn(fixture.transcript)], fixture);
		assert.equal(events.length, 1);
		const payload = JSON.parse(events[0]?.payload ?? "{}");
		assert.equal(payload.resetsAt, null);
		assert.equal(payload.rateLimitType, null);
		assert.equal(payload.apiErrorStatus, 429);
		rt.closeDb();
	} finally {
		rmSync(fixture.home, { recursive: true, force: true });
	}
});

test("a failed turn with another error raises no rate limit event", async () => {
	const fixture = fixtureWith([OTHER_ERROR_ROW]);
	try {
		const { rt, events } = await runMonitor([failedTurn(fixture.transcript)], fixture);
		assert.equal(events.length, 0, "another API error raises no rate limit event");
		rt.closeDb();
	} finally {
		rmSync(fixture.home, { recursive: true, force: true });
	}
});

test("a rate limit at the end of a large transcript raises the event", async () => {
	const filler = `${JSON.stringify({ type: "assistant", text: "x".repeat(1000) })}\n`;
	let body = "";
	while (body.length < 5 * 1024 * 1024) body += filler;
	const fixture = fixtureWith([RATE_LIMIT_ROW], body);
	try {
		const { rt, events } = await runMonitor([failedTurn(fixture.transcript)], fixture);
		assert.equal(events.length, 1, "the reader reads the tail of a large file");
		rt.closeDb();
	} finally {
		rmSync(fixture.home, { recursive: true, force: true });
	}
});

test("a path outside the projects of Claude Code raises no event", async () => {
	const home = mkdtempSync(join(tmpdir(), "wz-home-"));
	const outside = join(home, "secret.jsonl");
	writeFileSync(outside, `${RATE_LIMIT_ROW}\n`);
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	try {
		const { rt, events } = await runMonitor([failedTurn(outside)], { home, transcript: outside });
		assert.equal(events.length, 0, "the owner reads no file outside the projects of Claude Code");
		rt.closeDb();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a replayed failed turn raises no second event", async () => {
	const fixture = fixtureWith([RATE_LIMIT_ROW]);
	try {
		const { rt, events } = await runMonitor(
			[failedTurn(fixture.transcript), failedTurn(fixture.transcript)],
			fixture,
		);
		assert.equal(events.length, 1, "one limit gives one event");
		rt.closeDb();
	} finally {
		rmSync(fixture.home, { recursive: true, force: true });
	}
});

test("a later turn resolves the event and the history stays", async () => {
	const fixture = fixtureWith([RATE_LIMIT_ROW]);
	try {
		const { rt, tick, events, state } = await runMonitor([failedTurn(fixture.transcript)], fixture);
		assert.equal(pendingEvents(rt.openDb()).length, 1, "the event waits for the owner");

		applyObservation(state, startedTurn());
		tick();
		await settle();

		assert.equal(pendingEvents(rt.openDb()).length, 0, "the new turn resolves the event");
		assert.equal(eventsOfRun(rt.openDb(), "wz-1").length, 1, "the history of the event stays");
		assert.equal(events[0]?.condition, "rate_limited");
		rt.closeDb();
	} finally {
		rmSync(fixture.home, { recursive: true, force: true });
	}
});

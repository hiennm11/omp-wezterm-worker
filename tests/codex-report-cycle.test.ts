/**
 * The report of a Codex worker and the turn that produced it.
 *
 * The report server of Codex reads the turn id of the call and sends it as
 * the cycle id of the report. The supervisor binds the report to the cycle
 * that the turn id names. A report that names no turn never ends a worker,
 * and it raises one event for the owner.
 *
 * The test drives the real report server. The server posts the report to the
 * bridge of the run, and the monitor of the run reads the state of that
 * bridge.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleMessage, type ReportMessage } from "../extensions/codex-report/report-server.ts";
import { startBridge } from "../extensions/lib/claude-bridge.ts";
import { type ClaudeRunState, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { eventsOfRun } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { observeNative } from "../extensions/lib/native-ledger.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { flush } from "./reattach-native-helpers.ts";

/** The turn id of the real message of the app server of Codex. */
const TURN = "01a197ba-7450-7473-ba85-a8a45ed8c122";

/** The second cycle of the run. */
const NEXT_TURN = "turn-2";

/**
 * The `_meta` field of a real message of the app server of Codex.
 *
 * A real run of codex-cli 0.166.0 sent this field with the call of a tool.
 * The turn id sits in the turn metadata of the field.
 */
const REAL_META = {
	callId: "exec-1b72adc9",
	"x-codex-turn-metadata": {
		session_id: "01a197ba-5e5b",
		thread_id: "01a197ba-5e5b",
		turn_id: TURN,
		model: "gpt-6-luna",
		codex_version: "0.166.0",
	},
	threadId: "01a197ba-5e5b",
	sessionId: "01a197ba-5e5b",
	itemId: "ctc_098e8a87",
};

/**
 * A call of the report tool.
 *
 * The `_meta` field is the field of the real message. A call without that
 * field carries no turn id.
 */
function reportCall(meta: Record<string, unknown> | null): ReportMessage {
	return {
		id: 2,
		method: "tools/call",
		params: {
			...(meta === null ? {} : { _meta: meta }),
			name: "wezterm_worker_report",
			arguments: { state: "completed", result: "THE-ANSWER" },
		},
	};
}

/** A running Codex worker with a session directory. */
function codexJob(sessionDir: string): Job {
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
		backend: "codex",
	};
}

/** The report channel and the monitor of one Codex run. */
interface CodexRun {
	rt: WorkerRuntime;
	job: Job;
	state: ClaudeRunState;
	dir: string;
	/** Run one poll of the monitor. */
	tick: () => void;
	/** Send one observation of the app server to the bridge of the run. */
	observe: (source: string, payload: unknown) => Promise<void>;
	/** Send one report through the real report server. */
	report: (message: ReportMessage) => Promise<Record<string, unknown> | null>;
	/** Close the runtime and remove the directory of the test. */
	close: () => Promise<void>;
}

/** Build a Codex run whose polls run only when the test calls them. */
async function codexRun(): Promise<CodexRun> {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-cycle-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
	rt.config.stateDir = dir;
	let tick = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	const job = codexJob(sessionDir);
	rt.jobs.set(job.id, job);
	const state = createClaudeRunState(job.id);
	rt.claudeStates.set(job.id, state);
	const bridge = await startBridge(job.id, (observation) => {
		observeNative(rt, state, job.id, observation);
	});
	rt.bridges.set(job.id, bridge);
	const env: NodeJS.ProcessEnv = {
		WEZTERM_WORKER_URL: bridge.baseUrl,
		WEZTERM_WORKER_TOKEN: bridge.token,
		WEZTERM_WORKER_RUN_ID: job.id,
		WEZTERM_WORKER_SESSION_DIR: sessionDir,
	};
	return {
		rt,
		job,
		state,
		dir,
		tick: () => tick(),
		observe: async (source, payload) => {
			const response = await fetch(`${bridge.baseUrl}/observations`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${bridge.token}`,
				},
				body: JSON.stringify({
					backend: "codex",
					runId: job.id,
					sessionId: null,
					source,
					payload,
				}),
			});
			assert.equal(response.status, 202, `the bridge refused the ${source} observation`);
		},
		report: (message) => handleMessage(message, env),
		close: async () => {
			await bridge.close();
			rt.closeDb();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** The events of the run that carry the given condition. */
function eventsWithCondition(run: CodexRun, condition: string): number {
	return eventsOfRun(run.rt.openDb(), run.job.id).filter((event) => event.condition === condition).length;
}

test("a report of the turn that runs ends the worker", async () => {
	const run = await codexRun();
	try {
		await run.observe("turn.start", { turnId: TURN });
		await run.observe("turn.complete", { turnId: TURN, usage: null });
		const answer = await run.report(reportCall(REAL_META));
		assert.ok(answer, "the server gave no answer");
		assert.equal((answer.result as { isError: boolean }).isError, false, "the server refused the report");

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(run.rt, run.job, () => notified.resolve());
		run.tick();
		await notified.promise;

		assert.equal(run.job.status, "completed", "the report of the running turn did not end the worker");
		assert.equal(run.job.result, "THE-ANSWER");
	} finally {
		await run.close();
	}
});

test("a report of an earlier turn does not end the current cycle", async () => {
	const run = await codexRun();
	try {
		await run.observe("turn.start", { turnId: TURN });
		await run.observe("turn.complete", { turnId: TURN, usage: null });
		await run.report(reportCall(REAL_META));
		await run.observe("turn.start", { turnId: NEXT_TURN });
		await run.observe("turn.complete", { turnId: NEXT_TURN, usage: null });

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(run.rt, run.job, () => notified.resolve());
		run.tick();
		await flush(20);

		assert.equal(run.job.status, "running", "the report of the earlier turn ended the worker");
	} finally {
		await run.close();
	}
});

test("a report without a turn never ends the worker and raises one event", async () => {
	const run = await codexRun();
	try {
		await run.observe("turn.start", { turnId: TURN });
		await run.observe("turn.complete", { turnId: TURN, usage: null });
		await run.report(reportCall(null));

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(run.rt, run.job, () => notified.resolve());
		run.tick();
		await flush(20);

		assert.equal(run.job.status, "running", "the report without a turn ended the worker");
		assert.equal(eventsWithCondition(run, "missing_report"), 1, "the run holds no missing report event");

		await run.report(reportCall(null));
		run.tick();
		await flush(20);

		assert.equal(run.job.status, "running", "the second report without a turn ended the worker");
		assert.equal(eventsWithCondition(run, "missing_report"), 1, "the second report raised a second event");
	} finally {
		await run.close();
	}
});

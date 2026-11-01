/**
 * A queued instruction and an early report of a Codex worker.
 *
 * The owner queues a steering instruction while a turn runs. The server
 * accepts the instruction, and the instruction waits for its delivery. A
 * report that arrives before that delivery proves nothing about the work that
 * the instruction starts, so the worker keeps running.
 *
 * The test drives the monitor of a Codex worker. The steer path sends the
 * instruction through the request `turn/steer`, and the delivery arrives with
 * the item of the message that the server sends for it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handleMessage, type ReportMessage } from "../extensions/codex-report/report-server.ts";
import { startBridge } from "../extensions/lib/claude-bridge.ts";
import { type ClaudeRunState, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import type { CodexClient, CodexProtocolMessage } from "../extensions/lib/codex-client.ts";
import { translateCodexMessage } from "../extensions/lib/codex-events.ts";
import { steerCodex } from "../extensions/lib/codex-session.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { observeNative } from "../extensions/lib/native-ledger.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { flush } from "./reattach-native-helpers.ts";

/** The turn that the worker runs. */
const TURN = "turn-1";

/** The metadata of a real call of the app server of Codex. */
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

/** A call of the report tool that carries the id of the running turn. */
function reportCall(): ReportMessage {
	return {
		id: 2,
		method: "tools/call",
		params: {
			_meta: REAL_META,
			name: "wezterm_worker_report",
			arguments: { state: "completed", result: "THE-ANSWER" },
		},
	};
}

/** A client that records the requests of the test. */
function fakeClient(): CodexClient {
	return {
		request: async (): Promise<CodexProtocolMessage> => ({ id: 1, result: {} }),
		notify: () => undefined,
		close: () => undefined,
		setMessageHandler: () => undefined,
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

test("a queued instruction blocks a report that arrives before its delivery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-queue-"));
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
	const state: ClaudeRunState = createClaudeRunState(job.id);
	const bridge = await startBridge(job.id, (observation) => {
		observeNative(rt, state, job.id, observation);
	});
	try {
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, state);

		/* The turn of the worker starts. */
		observeNative(rt, state, job.id, {
			backend: "codex",
			runId: job.id,
			sessionId: null,
			source: "turn.start",
			payload: { turnId: TURN },
		});

		/* The owner queues an instruction. The server accepts it, and the
		   instruction waits for its delivery. */
		const outcome = await steerCodex(fakeClient(), state, "thread-1", "Write QUEUED to queued.txt");
		assert.equal(outcome.ok, true, "the server refused the instruction");
		assert.equal(state.pendingInstructions.size, 1, "the instruction did not wait for its delivery");

		/* The report of the running turn arrives before the delivery. The
		   report server names the turn that produced the report, and it
		   posts the report to the bridge of the run. */
		const env: NodeJS.ProcessEnv = {
			WEZTERM_WORKER_URL: bridge.baseUrl,
			WEZTERM_WORKER_TOKEN: bridge.token,
			WEZTERM_WORKER_RUN_ID: job.id,
			WEZTERM_WORKER_SESSION_DIR: sessionDir,
		};
		await handleMessage(reportCall(), env);
		const report = state.reports[0];
		assert.ok(report, "the report did not reach the run state");
		assert.equal(report.cycleId, TURN, "the report names no cycle of the running turn");

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		await flush(20);

		assert.equal(job.status, "running", "the early report ended the worker");

		/* The turn that ran before the instruction ends. Its end clears the
		   last blocker of the turn, so the pending instruction is the only
		   thing that still holds the worker. */
		observeNative(rt, state, job.id, {
			backend: "codex",
			runId: job.id,
			sessionId: null,
			source: "turn.complete",
			payload: { turnId: TURN, usage: null },
		});
		tick();
		await flush(20);

		assert.equal(job.status, "running", "the queued instruction did not block the report of the ended turn");

		/* The instruction arrives. The report of the turn now ends the
		   worker, because the worker owes no cycle any more. */
		const item = {
			source: "item/started",
			payload: {
				item: {
					type: "userMessage",
					id: "01a190b2-183d-7091-9cb7-ce337c402560",
					clientId: outcome.commandId ?? "",
					content: [{ type: "text", text: "Write QUEUED to queued.txt" }],
				},
				threadId: "thread-1",
				turnId: TURN,
			},
		};
		for (const observation of translateCodexMessage(item, {
			turnId: null,
			base: null,
			turn: null,
			last: null,
		})) {
			observeNative(rt, state, job.id, observation);
		}
		assert.equal(state.pendingInstructions.size, 0, "the delivery did not clear the instruction");

		tick();
		await notified.promise;

		assert.equal(job.status, "completed", "the report of the running turn did not end the worker");
		assert.equal(job.result, "THE-ANSWER");
	} finally {
		await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

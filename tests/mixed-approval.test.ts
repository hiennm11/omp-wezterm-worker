/**
 * The independent approvals of the native workers.
 *
 * An open permission request of the worker of the Claude Code backend blocks
 * that worker only. The worker of the Codex backend still accepts an
 * instruction and can complete. The answer that resolves the approval of one
 * worker leaves the approval of the other worker open.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyObservation, claudeCompletionBlocker } from "../extensions/lib/claude-run-state.ts";
import { steerCodex } from "../extensions/lib/codex-session.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";

import { flush, mixedMachine, startClaude, startCodex } from "./mixed-helpers.ts";

/** The id of the worker of the Claude Code backend. */
const CLAUDE = "wz-mixed-claude";

/** The id of the worker of the Codex backend. */
const CODEX = "wz-mixed-codex";

/** The thread of the worker of the Codex backend. */
const THREAD = "thread-1";

/** The cycle of the worker of the Claude Code backend. */
const CLAUDE_CYCLE = "turn-claude";

/** The cycle of the worker of the Codex backend. */
const CODEX_CYCLE = "turn-codex";

/** The id of the call that waits for the approval of the Claude worker. */
const CLAUDE_CALL = "call-claude";

/** The id of the call that waits for the approval of the Codex worker. */
const CODEX_CALL = "call-codex";

test("an open approval of one native worker leaves the other worker free", async () => {
	const machine = mixedMachine();
	try {
		await startClaude(machine, CLAUDE);
		await startCodex(machine, CODEX);
		const claudeState = machine.rt.claudeStates.get(CLAUDE);
		const codexState = machine.rt.claudeStates.get(CODEX);
		assert.ok(claudeState, "the Claude worker holds no run state");
		assert.ok(codexState, "the Codex worker holds no run state");

		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "turn.start",
			payload: { turnId: CLAUDE_CYCLE },
		});
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "turn.start",
			payload: { turnId: CODEX_CYCLE },
		});

		/* The person answers a call of the Claude worker in its pane. The
		   request waits for the answer. */
		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "tool.check",
			payload: { callId: CLAUDE_CALL, tool: "Bash", decision: "ask" },
		});
		/* The Codex worker asks for an approval of its own. */
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "tool.check",
			payload: { callId: CODEX_CALL, tool: "commandExecution", decision: "ask" },
		});

		assert.match(
			claudeCompletionBlocker(claudeState) ?? "",
			/permission request/,
			"the Claude worker has no blocker",
		);
		assert.match(
			claudeCompletionBlocker(codexState) ?? "",
			/permission request/,
			"the Codex worker has no blocker",
		);

		/* The answer of the approval of the Claude worker settles its
		   call. The approval of the Codex worker stays open. */
		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "tool.call.settled",
			payload: { callId: CLAUDE_CALL, tool: "Bash", denied: false, isError: false },
		});
		assert.equal(claudeState.openApprovals.size, 0, "the approval of the Claude worker stayed open");
		assert.equal(codexState.openApprovals.size, 1, "the answer of the Claude worker closed the Codex worker");
	} finally {
		await machine.cleanup();
	}
});

test("the Codex worker accepts an instruction while the Claude worker waits for the person", async () => {
	const machine = mixedMachine();
	try {
		await startClaude(machine, CLAUDE);
		await startCodex(machine, CODEX);
		const claudeState = machine.rt.claudeStates.get(CLAUDE);
		const codexState = machine.rt.claudeStates.get(CODEX);
		assert.ok(claudeState, "the Claude worker holds no run state");
		assert.ok(codexState, "the Codex worker holds no run state");

		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "turn.start",
			payload: { turnId: CLAUDE_CYCLE },
		});
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "turn.start",
			payload: { turnId: CODEX_CYCLE },
		});
		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "tool.check",
			payload: { callId: CLAUDE_CALL, tool: "Bash", decision: "ask" },
		});

		/* The Codex worker has no open approval, so it accepts the
		   instruction of the owner. */
		const codexClient = machine.rt.codexClients.get(CODEX);
		assert.ok(codexClient, "the Codex worker holds no client");
		const outcome = await steerCodex(codexClient, codexState, THREAD, "Write CODEX to codex.txt");
		assert.equal(outcome.ok, true, "the server refused the instruction of the Codex worker");
		assert.equal(codexState.pendingInstructions.size, 1, "the instruction of the Codex worker did not wait");
		assert.equal(claudeState.openApprovals.size, 1, "the approval of the Claude worker did not stay open");
	} finally {
		await machine.cleanup();
	}
});

test("the Codex worker completes while the approval of the Claude worker waits", async () => {
	const machine = mixedMachine();
	try {
		await startClaude(machine, CLAUDE);
		await startCodex(machine, CODEX);
		const claude = machine.rt.jobs.get(CLAUDE);
		const codex = machine.rt.jobs.get(CODEX);
		assert.ok(claude, "the runtime holds no Claude worker");
		assert.ok(codex, "the runtime holds no Codex worker");
		const claudeState = machine.rt.claudeStates.get(CLAUDE);
		const codexState = machine.rt.claudeStates.get(CODEX);
		assert.ok(claudeState, "the Claude worker holds no run state");
		assert.ok(codexState, "the Codex worker holds no run state");

		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "turn.start",
			payload: { turnId: CLAUDE_CYCLE },
		});
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "turn.start",
			payload: { turnId: CODEX_CYCLE },
		});
		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "tool.check",
			payload: { callId: CLAUDE_CALL, tool: "Bash", decision: "ask" },
		});
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "turn.complete",
			payload: { turnId: CODEX_CYCLE, usage: null },
		});
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "report",
			payload: { cycleId: CODEX_CYCLE, state: "completed", result: "the answer of Codex" },
		});

		const ended = Promise.withResolvers<void>();
		monitorNativeJob(machine.rt, codex, () => ended.resolve());
		monitorNativeJob(machine.rt, claude, () => ended.resolve());
		machine.timers.tick();
		await flush(20);
		await ended.promise;

		assert.equal(codex.status, "completed", "the Codex worker did not complete");
		assert.equal(codex.result, "the answer of Codex", "the Codex worker holds no result");
		assert.equal(claude.status, "running", "the Claude worker completed while its approval waited");
	} finally {
		await machine.cleanup();
	}
});

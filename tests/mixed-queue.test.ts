/**
 * The independent instruction queues of the native workers.
 *
 * A worker of the Claude Code backend and a worker of the Codex backend each
 * hold an accepted instruction that waits for its delivery. The delivery of
 * the instruction of one worker leaves the other worker blocked. A blocked
 * instruction keeps its worker running, because the worker still owes a cycle.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyObservation, claudeCompletionBlocker } from "../extensions/lib/claude-run-state.ts";
import { steerCodex } from "../extensions/lib/codex-session.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { steerNative } from "../extensions/lib/steer-native.ts";

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

/** Wait until the bridge of a run holds a command. */
async function waitForCommand(commands: { id: string }[]): Promise<{ id: string }> {
	for (let step = 0; step < 200; step += 1) {
		const command = commands[0];
		if (command) return command;
		await flush(1);
	}
	throw new Error("the bridge of the worker holds no command");
}

test("the delivery of the instruction of one native worker leaves the other worker blocked", async () => {
	const machine = mixedMachine();
	try {
		const claude = await startClaude(machine, CLAUDE);
		const codex = await startCodex(machine, CODEX);
		assert.equal(claude.status, "running", "the Claude worker did not start");
		assert.equal(codex.status, "running", "the Codex worker did not start");

		const claudeState = machine.rt.claudeStates.get(CLAUDE);
		const codexState = machine.rt.claudeStates.get(CODEX);
		assert.ok(claudeState, "the Claude worker holds no run state");
		assert.ok(codexState, "the Codex worker holds no run state");

		/* Both workers run a turn, so a steering instruction has a cycle to
		   join. */
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

		/* The owner queues one instruction for each worker. The Claude
		   worker takes the instruction through its bridge, and the Codex
		   worker through the queue of Codex. */
		const claudeBridge = machine.rt.bridges.get(CLAUDE);
		assert.ok(claudeBridge, "the Claude worker holds no bridge");
		const steered = steerNative(claudeBridge, claudeState, "Write CLAUDE to claude.txt");
		const command = await waitForCommand(claudeBridge.commands);
		claudeBridge.results.set(command.id, {
			id: command.id,
			phase: "accepted",
			nativeId: "instr-claude",
			error: null,
		});
		const claudeOutcome = await steered;
		assert.equal(claudeOutcome.ok, true, "the worker refused the instruction of the Claude worker");
		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "command.accepted",
			payload: { id: command.id, instructionId: "instr-claude" },
		});

		const codexClient = machine.rt.codexClients.get(CODEX);
		assert.ok(codexClient, "the Codex worker holds no client");
		const codexOutcome = await steerCodex(codexClient, codexState, THREAD, "Write CODEX to codex.txt");
		assert.equal(codexOutcome.ok, true, "the server refused the instruction of the Codex worker");

		assert.match(
			claudeCompletionBlocker(claudeState) ?? "",
			/instruction/,
			"the Claude worker has no blocker",
		);
		assert.match(claudeCompletionBlocker(codexState) ?? "", /instruction/, "the Codex worker has no blocker");

		/* The instruction of the Codex worker is delivered. Its delivery
		   clears the list of the Codex worker only. */
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "instruction.delivered",
			payload: { uuid: "uuid-codex", instructionId: codexOutcome.commandId },
		});
		assert.equal(codexState.pendingInstructions.size, 0, "the delivery did not clear the Codex worker");
		assert.match(
			claudeCompletionBlocker(claudeState) ?? "",
			/instruction/,
			"the delivery of the Codex worker cleared the Claude worker",
		);
	} finally {
		await machine.cleanup();
	}
});

test("a worker with a pending instruction stays running while the other worker ends", async () => {
	const machine = mixedMachine();
	try {
		const claude = await startClaude(machine, CLAUDE);
		const codex = await startCodex(machine, CODEX);
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
			source: "command.accepted",
			payload: { id: "cmd-claude", instructionId: "instr-claude" },
		});
		const codexClient = machine.rt.codexClients.get(CODEX);
		assert.ok(codexClient, "the Codex worker holds no client");
		const codexOutcome = await steerCodex(codexClient, codexState, THREAD, "Write CODEX to codex.txt");
		assert.equal(codexOutcome.ok, true, "the server refused the instruction of the Codex worker");

		/* Both workers report a completion. The instruction of the Claude
		   worker waits for its delivery, so the Claude worker stays
		   running. The Codex worker has no blocker, so it ends. */
		applyObservation(codexState, {
			backend: "codex",
			runId: CODEX,
			sessionId: THREAD,
			source: "instruction.delivered",
			payload: { uuid: "uuid-codex", instructionId: codexOutcome.commandId },
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
		applyObservation(claudeState, {
			backend: "claude",
			runId: CLAUDE,
			sessionId: null,
			source: "report",
			payload: { cycleId: CLAUDE_CYCLE, state: "completed", result: "the answer of Claude" },
		});

		const ended = Promise.withResolvers<void>();
		monitorNativeJob(machine.rt, codex, () => ended.resolve());
		monitorNativeJob(machine.rt, claude, () => ended.resolve());
		machine.timers.tick();
		await flush(20);
		await ended.promise;

		assert.equal(codex.status, "completed", "the Codex worker did not end");
		assert.equal(claude.status, "running", "the Claude worker ended while its instruction waited");
	} finally {
		await machine.cleanup();
	}
});

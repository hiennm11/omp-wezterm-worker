/**
 * The stop intent of a native worker beside the workers of the other backends.
 *
 * A pending stop intent of the worker of the Claude Code backend refuses a
 * steering instruction and a resume of that worker only. The worker of the
 * OMP backend and the worker of the Codex backend still accept a steering
 * instruction. A completion report that arrives for the Claude worker after
 * its stop intent does not complete it. The same holds for the worker of the
 * Codex backend.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyObservation } from "../extensions/lib/claude-run-state.ts";
import { cancelJob } from "../extensions/lib/lifecycle.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { recordStopIntent } from "../extensions/lib/stop-intent.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { registerSteerTool } from "../extensions/worker-tools/steer.ts";

import { flush, type MixedMachine, mixedMachine, replyText, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The session that owns the workers of the test. */
const OWN = "session-mixed";

/** The instruction that the test sends into a worker. */
const INSTRUCTION = "Write the answer into the file of the task.";

/** The ids of the workers of the three backends. */
interface StartedWorkers {
	omp: string;
	claude: string;
	codex: string;
}

/** Start one worker of every backend and return their ids. */
async function startThreeBackends(machine: MixedMachine): Promise<StartedWorkers> {
	machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
	const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
	const ctx = toolCtx(machine.dir, OWN);
	const started: Partial<StartedWorkers> = {};
	for (const backend of ["omp", "claude", "codex"] as const) {
		const result = await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
		assert.equal(result.isError, undefined, `the ${backend} worker did not start`);
		started[backend] = result.details.workerId as string;
	}
	return started as StartedWorkers;
}

/** Open a turn in the run state of a native worker. */
function openTurn(machine: MixedMachine, workerId: string, turnId: string): void {
	const state = machine.rt.claudeStates.get(workerId);
	assert.ok(state, `the worker ${workerId} holds no run state`);
	applyObservation(state, {
		backend: "codex",
		runId: workerId,
		sessionId: null,
		source: "turn.start",
		payload: { turnId },
	});
}

/**
 * Steer the worker of the Claude Code backend and accept its instruction.
 *
 * The worker of the extension accepts the instruction of its owner through
 * the bridge. The test plays that worker, so the steer does not wait for the
 * timeout of the extension. The command of the bridge appears as soon as the
 * tool queues it, so the test answers it without a timer.
 */
async function steerClaude(machine: MixedMachine, workerId: string) {
	const steer = toolOf(machine.rt, registerSteerTool, "steer");
	const ctx = toolCtx(machine.dir, OWN);
	const pending = steer.execute("t1", { workerId, message: INSTRUCTION }, ctx);
	const bridge = machine.rt.bridges.get(workerId);
	assert.ok(bridge, `the worker ${workerId} holds no bridge`);
	await flush(1);
	const command = bridge.commands[0];
	assert.ok(command, "the bridge of the worker holds no command");
	bridge.results.set(command.id, {
		id: command.id,
		phase: "accepted",
		nativeId: `instr-${command.id}`,
		error: null,
	});
	return pending;
}

/**
 * Steer the worker of the Codex backend.
 *
 * The worker of Codex accepts the instruction through the request
 * `turn/steer`, so the fake app server answers it at once.
 */
async function steerCodex(machine: MixedMachine, workerId: string) {
	const steer = toolOf(machine.rt, registerSteerTool, "steer");
	const ctx = toolCtx(machine.dir, OWN);
	return steer.execute("t1", { workerId, message: INSTRUCTION }, ctx);
}

test("a pending stop intent of the Claude worker refuses a steer of that worker only", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		openTurn(machine, started.claude, "turn-claude");
		openTurn(machine, started.codex, "turn-codex");

		/* The stop of the Claude worker did not confirm its pane, so the
		   intent stays pending. */
		recordStopIntent(
			machine.rt.openDb(),
			`stop-${started.claude}`,
			started.claude,
			"cancelled",
			"Cancelled by the main agent",
			Date.now(),
		);

		const steer = toolOf(machine.rt, registerSteerTool, "steer");
		const ctx = toolCtx(machine.dir, OWN);
		const refused = await steer.execute("t1", { workerId: started.claude, message: INSTRUCTION }, ctx);
		assert.equal(refused.isError, true, "the steer of the Claude worker was not refused");
		assert.match(replyText(refused), /pending stop intent/, "the refusal names no stop intent");

		/* The worker of the Codex backend still takes its instruction. */
		const codex = await steerCodex(machine, started.codex);
		assert.equal(codex.isError, undefined, "the steer of the Codex worker was refused");
	} finally {
		await machine.cleanup();
	}
});

test("a pending stop intent of the Codex worker refuses a steer of that worker only", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		openTurn(machine, started.claude, "turn-claude");
		openTurn(machine, started.codex, "turn-codex");

		recordStopIntent(
			machine.rt.openDb(),
			`stop-${started.codex}`,
			started.codex,
			"cancelled",
			"Cancelled by the main agent",
			Date.now(),
		);

		const steer = toolOf(machine.rt, registerSteerTool, "steer");
		const ctx = toolCtx(machine.dir, OWN);
		const refused = await steer.execute("t1", { workerId: started.codex, message: INSTRUCTION }, ctx);
		assert.equal(refused.isError, true, "the steer of the Codex worker was not refused");
		assert.match(replyText(refused), /pending stop intent/, "the refusal names no stop intent");

		/* The worker of the Claude backend still takes its instruction. */
		const claude = await steerClaude(machine, started.claude);
		assert.equal(claude.isError, undefined, "the steer of the Claude worker was refused");
	} finally {
		await machine.cleanup();
	}
});

test("a completion report after a stop intent does not complete the Claude worker", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		openTurn(machine, started.claude, "turn-claude");

		/* The cancel of the Claude worker does not confirm its pane, so the
		   stop of the worker stays pending and the intent stays pending. */
		const claude = machine.rt.jobs.get(started.claude);
		assert.ok(claude, "the runtime holds no Claude worker");
		machine.keepPaneOnKill = true;
		const outcome = await cancelJob(machine.rt, claude);
		assert.equal(outcome.stopped, false, "the stop of the Claude worker was confirmed");
		assert.ok(claude.pendingStop, "the stop of the Claude worker is not pending");

		/* The worker reports its completion after the stop intent. The
		   turn of the worker ended, so the report is the only evidence
		   that the worker is done. The monitor gives the pending stop the
		   first place, so the report does not complete the worker. */
		const state = machine.rt.claudeStates.get(started.claude);
		assert.ok(state, "the Claude worker holds no run state");
		applyObservation(state, {
			backend: "claude",
			runId: started.claude,
			sessionId: null,
			source: "turn.complete",
			payload: { turnId: "turn-claude", usage: null },
		});
		applyObservation(state, {
			backend: "claude",
			runId: started.claude,
			sessionId: null,
			source: "report",
			payload: { cycleId: "turn-claude", state: "completed", result: "the answer of Claude" },
		});

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(machine.rt, claude, () => notified.resolve());
		machine.timers.tick();
		await flush(20);

		assert.notEqual(claude.status, "completed", "the report completed the worker with a pending stop");
		assert.equal(claude.status, "running", "the worker ended although its stop waits for confirmation");
	} finally {
		await machine.cleanup();
	}
});

test("a completion report after a stop intent does not complete the Codex worker", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		openTurn(machine, started.codex, "turn-codex");

		/* The cancel of the Codex worker does not end the program of its
		   app server, so the stop of the worker stays pending. */
		const codex = machine.rt.jobs.get(started.codex);
		assert.ok(codex, "the runtime holds no Codex worker");
		machine.taskkillFailures = 1;
		const outcome = await cancelJob(machine.rt, codex);
		assert.equal(outcome.stopped, false, "the stop of the Codex worker was confirmed");
		assert.ok(codex.pendingStop, "the stop of the Codex worker is not pending");

		const state = machine.rt.claudeStates.get(started.codex);
		assert.ok(state, "the Codex worker holds no run state");
		applyObservation(state, {
			backend: "codex",
			runId: started.codex,
			sessionId: null,
			source: "turn.complete",
			payload: { turnId: "turn-codex", usage: null },
		});
		applyObservation(state, {
			backend: "codex",
			runId: started.codex,
			sessionId: null,
			source: "report",
			payload: { cycleId: "turn-codex", state: "completed", result: "the answer of Codex" },
		});

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(machine.rt, codex, () => notified.resolve());
		machine.timers.tick();
		await flush(20);

		assert.notEqual(codex.status, "completed", "the report completed the worker with a pending stop");
		assert.notEqual(codex.result, "the answer of Codex", "the report of the worker became its result");
	} finally {
		await machine.cleanup();
	}
});

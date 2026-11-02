/**
 * The cleanup of a worker of the Codex backend beside the other workers.
 *
 * The cleanup of the run of the Codex worker refuses while its event waits
 * for the owner. After the acknowledgement, the cleanup removes only the
 * session folder of that run and leaves the folders of the other two workers.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { applyObservation } from "../extensions/lib/claude-run-state.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

import { mixedMachine, replyText, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The session that owns the workers of the test. */
const OWN = "session-mixed";

/** Start one worker of every backend and return their ids. */
async function startThreeBackends(machine: ReturnType<typeof mixedMachine>) {
	machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
	machine.rt.config.maxActiveWorkers = 0;
	machine.rt.config.maxLaunchesPerRequest = 0;
	const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
	const ctx = toolCtx(machine.dir, OWN);
	const started: Record<string, string> = {};
	for (const backend of ["omp", "claude", "codex"]) {
		const result = await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
		assert.equal(result.isError, undefined, `the ${backend} worker did not start`);
		started[backend] = result.details.workerId as string;
	}
	return started;
}

/** Raise the permission event of a native worker. */
function raisePermissionEvent(machine: ReturnType<typeof mixedMachine>, workerId: string): string {
	const state = machine.rt.claudeStates.get(workerId);
	assert.ok(state, `the worker ${workerId} holds no run state`);
	applyObservation(state, {
		backend: "codex",
		runId: workerId,
		sessionId: null,
		source: "tool.check",
		payload: { callId: `call-${workerId}`, tool: "commandExecution", decision: "ask" },
	});
	machine.timers.tick();
	return `ev-${workerId}-approval-call-${workerId}-permission_request`;
}

test("the cleanup of the Codex run refuses while its event waits for the owner", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const codex = machine.rt.jobs.get(started.codex);
		assert.ok(codex, "the runtime holds no Codex worker");
		const eventId = raisePermissionEvent(machine, started.codex);
		await finalizeJob(machine.rt, codex, "completed", null, "the answer of Codex");

		const cleanup = toolOf(machine.rt, registerCleanupTool, "cleanup");
		const ctx = toolCtx(machine.dir, OWN);
		const refused = await cleanup.execute("t2", { workerId: started.codex }, ctx);
		assert.equal(refused.isError, true, "the cleanup was not refused");
		assert.match(replyText(refused), /unhandled event/, "the refusal names no unhandled event");
		assert.deepEqual(refused.details.pendingEvents, [eventId], "the refusal names another event");
		assert.equal(existsSync(codex.sessionDir), true, "the cleanup removed the session folder");
	} finally {
		await machine.cleanup();
	}
});

test("the cleanup of the Codex run removes only its session folder after the acknowledgement", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const codex = machine.rt.jobs.get(started.codex);
		const claude = machine.rt.jobs.get(started.claude);
		const omp = machine.rt.jobs.get(started.omp);
		assert.ok(codex, "the runtime holds no Codex worker");
		assert.ok(claude, "the runtime holds no Claude worker");
		assert.ok(omp, "the runtime holds no OMP worker");
		const eventId = raisePermissionEvent(machine, started.codex);
		await finalizeJob(machine.rt, codex, "completed", null, "the answer of Codex");

		/* The owner handles the event of the Codex worker. */
		const ack = toolOf(machine.rt, registerAckTool, "ack");
		const ctx = toolCtx(machine.dir, OWN);
		const answered = await ack.execute("t2", {
			workerId: started.codex,
			eventId,
			disposition: "accepted",
		});
		assert.equal(answered.details.acknowledged, true, "the acknowledgement of the Codex worker failed");

		const cleanup = toolOf(machine.rt, registerCleanupTool, "cleanup");
		const done = await cleanup.execute("t3", { workerId: started.codex }, ctx);
		assert.equal(done.isError, undefined, `the cleanup was refused: ${replyText(done)}`);
		assert.match(replyText(done), /transcript directory removed/, "the cleanup removed no session folder");

		assert.equal(existsSync(codex.sessionDir), false, "the session folder of the Codex run stayed");
		assert.equal(existsSync(claude.sessionDir), true, "the cleanup removed the session folder of Claude");
		assert.equal(existsSync(omp.sessionDir), true, "the cleanup removed the session folder of OMP");
	} finally {
		await machine.cleanup();
	}
});

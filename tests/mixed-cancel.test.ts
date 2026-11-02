/**
 * The cancel of a worker of the Claude Code backend beside the other workers.
 *
 * The cancel of the worker of the Claude Code backend closes only the pane of
 * that worker. It ends no program of the worker of the Codex backend and no
 * pane of the worker of the OMP backend. The fake panes of the machine stand
 * for the panes of the real WezTerm.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { registerCancelTool } from "../extensions/worker-tools/cancel.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

import { mixedMachine, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The session that owns the workers of the test. */
const OWN = "session-mixed";

/** Start one worker of every backend and return their ids and panes. */
async function startThreeBackends(machine: ReturnType<typeof mixedMachine>) {
	machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
	machine.rt.config.maxActiveWorkers = 0;
	machine.rt.config.maxLaunchesPerRequest = 0;
	const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
	const ctx = toolCtx(machine.dir, OWN);
	const started: Record<string, { id: string; paneId: number }> = {};
	for (const backend of ["omp", "claude", "codex"]) {
		const result = await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
		assert.equal(result.isError, undefined, `the ${backend} worker did not start`);
		started[backend] = {
			id: result.details.workerId as string,
			paneId: result.details.paneId as number,
		};
	}
	return started;
}

test("the cancel of the Claude worker closes only the pane of the Claude worker", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const claudePane = started.claude.paneId;
		const ompPane = started.omp.paneId;
		const codexPane = started.codex.paneId;
		const codexServerPane = machine.rt.jobs.get(started.codex.id)?.codex?.serverPaneId ?? null;

		const cancel = toolOf(machine.rt, registerCancelTool, "cancel");
		const ctx = toolCtx(machine.dir, OWN);
		const cancelled = await cancel.execute("t2", { workerId: started.claude.id }, ctx);
		assert.equal(cancelled.isError, undefined, `the cancel was refused: ${cancelled.content[0]?.text}`);

		assert.deepEqual(machine.killedPanes, [claudePane], "the cancel closed the pane of another worker");
		assert.equal(machine.panes.has(ompPane), true, "the cancel closed the pane of the OMP worker");
		assert.equal(machine.panes.has(codexPane), true, "the cancel closed the pane of the Codex worker");
		if (codexServerPane !== null) {
			assert.equal(machine.panes.has(codexServerPane), true, "the cancel closed the pane of the app server");
		}
		assert.deepEqual(machine.taskkills, [], "the cancel ended a program of Codex");
		assert.equal(
			machine.rt.jobs.get(started.codex.id)?.status,
			"running",
			"the cancel ended the worker of the Codex backend",
		);
		assert.equal(
			machine.rt.jobs.get(started.omp.id)?.status,
			"running",
			"the cancel ended the worker of the OMP backend",
		);
	} finally {
		await machine.cleanup();
	}
});

test("the cancel of the Codex worker ends no program of the other workers", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const claudePane = started.claude.paneId;
		const ompPane = started.omp.paneId;

		const cancel = toolOf(machine.rt, registerCancelTool, "cancel");
		const ctx = toolCtx(machine.dir, OWN);
		const cancelled = await cancel.execute("t2", { workerId: started.codex.id }, ctx);
		assert.equal(cancelled.isError, undefined, `the cancel was refused: ${cancelled.content[0]?.text}`);

		/* The Codex worker owns an app server, so its cancel ends that
		   program and closes both of its panes. The panes of the other
		   workers stay open. */
		assert.equal(machine.taskkills.length, 1, "the cancel ended no program of the app server");
		assert.equal(machine.panes.has(claudePane), true, "the cancel closed the pane of the Claude worker");
		assert.equal(machine.panes.has(ompPane), true, "the cancel closed the pane of the OMP worker");
		assert.equal(
			machine.rt.jobs.get(started.claude.id)?.status,
			"running",
			"the cancel ended the worker of the Claude backend",
		);
		assert.equal(
			machine.rt.jobs.get(started.omp.id)?.status,
			"running",
			"the cancel ended the worker of the OMP backend",
		);
	} finally {
		await machine.cleanup();
	}
});

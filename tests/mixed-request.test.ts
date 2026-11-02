/**
 * The launch accounting of one request.
 *
 * The extension counts the launches of one request. A launch of the OMP
 * backend, a launch of the Claude Code backend and a launch of the Codex
 * backend count against the same limit `maxLaunchesPerRequest`. A refused
 * launch changes nothing. A new user prompt starts a new request, so the
 * count starts at zero again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { startRequest } from "../extensions/lib/limits.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

import { mixedMachine, replyText, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The backends that the test launches. */
const BACKENDS = ["omp", "claude", "codex"] as const;

test("the launches of the three backends count against one limit of the request", async () => {
	const machine = mixedMachine();
	try {
		machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
		/* The pool of active workers is a rule of its own. The test of the
		   request accounting must show the count of the request alone. */
		machine.rt.config.maxActiveWorkers = 0;
		machine.rt.config.maxLaunchesPerRequest = 3;
		const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
		const ctx = toolCtx(machine.dir, "session-mixed");

		for (const backend of BACKENDS) {
			const started = await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
			assert.equal(started.isError, undefined, `the ${backend} launch was refused`);
		}
		assert.equal(machine.rt.requestLaunches.length, 3, "the request holds no three launches");

		const refused = await spawn.execute("t2", { task: TASK, cwd: machine.dir, backend: "omp" }, ctx);
		assert.equal(refused.isError, true, "the fourth launch was not refused");
		assert.equal(refused.details.refused, "maxLaunchesPerRequest", "the refusal names another rule");
		assert.match(replyText(refused), /maxLaunchesPerRequest/, "the refusal does not name the rule");
		assert.equal(machine.rt.requestLaunches.length, 3, "a refused launch changed the count");
	} finally {
		await machine.cleanup();
	}
});

test("a new user prompt resets the count of the request", async () => {
	const machine = mixedMachine();
	try {
		machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
		machine.rt.config.maxActiveWorkers = 0;
		machine.rt.config.maxLaunchesPerRequest = 3;
		const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
		const ctx = toolCtx(machine.dir, "session-mixed");

		for (const backend of BACKENDS) {
			await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
		}
		const refused = await spawn.execute("t2", { task: TASK, cwd: machine.dir, backend: "omp" }, ctx);
		assert.equal(refused.details.refused, "maxLaunchesPerRequest", "the fourth launch was not refused");

		/* The user sends a new prompt. The request starts, so the count is
		   empty and the next launch is admitted. */
		startRequest(machine.rt);
		assert.deepEqual(machine.rt.requestLaunches, [], "the count of the request is not empty");

		const admitted = await spawn.execute("t3", { task: TASK, cwd: machine.dir, backend: "claude" }, ctx);
		assert.equal(admitted.isError, undefined, "the launch of the new request was refused");
		assert.equal(machine.rt.requestLaunches.length, 1, "the new request holds no launch");
	} finally {
		await machine.cleanup();
	}
});

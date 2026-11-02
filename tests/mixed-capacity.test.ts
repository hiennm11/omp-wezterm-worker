/**
 * The shared capacity of the workers of three backends.
 *
 * The extension holds one pool of active workers. A worker of the OMP
 * backend, a worker of the Claude Code backend and a worker of the Codex
 * backend take a slot of that pool. The fourth launch is refused with the
 * reason `maxActiveWorkers`, whatever the backend of the fourth launch.
 * When one worker of the pool ends, the next launch is admitted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isActive } from "../extensions/lib/job.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

import { mixedMachine, replyText, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The backends that the test launches. */
const BACKENDS = ["omp", "claude", "codex"] as const;

test("the three backends take a slot of one pool of active workers", async () => {
	const machine = mixedMachine();
	try {
		machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
		const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
		const ctx = toolCtx(machine.dir, "session-mixed");

		for (const backend of BACKENDS) {
			const started = await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
			assert.equal(started.isError, undefined, `the ${backend} worker did not start`);
		}
		assert.equal(machine.rt.jobs.size, 3, "the runtime does not hold three workers");

		for (const backend of BACKENDS) {
			const refused = await spawn.execute("t2", { task: TASK, cwd: machine.dir, backend }, ctx);
			assert.equal(refused.isError, true, `the ${backend} launch was not refused`);
			assert.equal(refused.details.refused, "maxActiveWorkers", "the refusal names another rule");
			assert.match(replyText(refused), /maxActiveWorkers/, "the refusal does not name the rule");
		}
		assert.equal(machine.rt.jobs.size, 3, "a refused launch started a worker");
	} finally {
		await machine.cleanup();
	}
});

test("the next launch is admitted when a worker of the pool ends", async () => {
	const machine = mixedMachine();
	try {
		machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
		/* The request limit is a rule of its own. The test of the shared
		   capacity must show the pool of active workers alone. */
		machine.rt.config.maxLaunchesPerRequest = 0;
		const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
		const ctx = toolCtx(machine.dir, "session-mixed");

		for (const backend of BACKENDS) {
			await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
		}
		const refused = await spawn.execute("t2", { task: TASK, cwd: machine.dir, backend: "omp" }, ctx);
		assert.equal(refused.details.refused, "maxActiveWorkers", "the fourth launch was not refused");

		/* The Claude worker of the pool ends. Its slot is free, so the next
		   launch of any backend is admitted. */
		const claude = [...machine.rt.jobs.values()].find((job) => job.backend === "claude");
		assert.ok(claude, "the runtime holds no Claude worker");
		await finalizeJob(machine.rt, claude, "completed", null, "the work of the task");

		const admitted = await spawn.execute("t3", { task: TASK, cwd: machine.dir, backend: "codex" }, ctx);
		assert.equal(admitted.isError, undefined, "the launch after the end was refused");
		const active = [...machine.rt.jobs.values()].filter((job) => isActive(job));
		assert.equal(active.length, 3, "the runtime does not hold three active workers after the launch");
	} finally {
		await machine.cleanup();
	}
});

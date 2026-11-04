/**
 * The recovery of three backends after a restart of the host.
 *
 * One host holds three workers of three backends. A new host opens the same
 * state directory and fires the event `session_start`. After the restart,
 * every backend holds exactly one worker with the old id. The recovery of
 * one backend does not take the task of a worker of another backend. No
 * program starts twice.
 *
 * A restart of a real OMP worker needs a real `omp` program, so the worker
 * of the OMP backend is tested with a fake. The workers of the Claude Code
 * backend and of the Codex backend use the real code paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attachWorker } from "../extensions/lib/attach.ts";
import { readBackend } from "../extensions/lib/backend.ts";
import { acquireTask, taskKey } from "../extensions/lib/owner.ts";
import { readOwnership } from "../extensions/lib/ownership.ts";
import { reconcileAttempts } from "../extensions/lib/recovery.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

import { type MixedMachine, mixedMachine, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The session that owns the workers of the test. */
const OWN = "session-mixed";

/** The worker ids of the test, by backend. */
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
		const workerId = result.details.workerId;
		assert.equal(typeof workerId, "string", `the ${backend} worker has no id`);
		started[backend] = workerId as string;
	}
	return started as StartedWorkers;
}

test("a new host finds one worker of every backend with the old id", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const launches = machine.launches;

		const second = machine.newHost({
			stateDir: machine.dir,
			sessionId: OWN,
			processId: 4343,
			processStartedAt: "2026-02-02T00:00:00.000Z",
		});
		try {
			/* The new host reads the registry of the state directory. */
			const restored = second.rt.readRegistry();
			const ids = restored.alive.map((job) => job.id).sort();
			assert.deepEqual(
				ids,
				[started.omp, started.claude, started.codex].sort(),
				"the new host holds other workers",
			);

			/* The recovery of the new host takes the task of every worker
			   of the session. It attaches to every worker. The attachment
			   of a worker of one backend starts no program of another
			   backend. */
			for (const job of restored.alive) {
				const acquisition = await acquireTask(second.rt, job.id);
				assert.equal(acquisition.acquired, true, `the new host took no task of worker ${job.id}`);
				second.rt.jobs.set(job.id, job);
				await attachWorker(second.rt, job, () => undefined);
			}
			assert.equal(machine.launches, launches, "the recovery started a program");
			for (const backend of ["omp", "claude", "codex"] as const) {
				const found = [...second.rt.jobs.values()].filter((job) => readBackend(job) === backend);
				assert.equal(found.length, 1, `the new host holds no one worker of the ${backend} backend`);
				assert.equal(found[0].id, started[backend], `the worker of the ${backend} backend lost its id`);
			}

			/* The recovery of the worker of the Codex backend attaches to
			   its app server again. The client of the app server is the
			   proof, because only the attachment creates it. */
			assert.equal(
				second.rt.codexClients.has(started.codex),
				true,
				"the recovery attached no client to the app server of the Codex worker",
			);
			assert.equal(
				second.rt.bridges.has(started.claude),
				true,
				"the recovery attached no bridge to the Claude worker",
			);
		} finally {
			await second.cleanup();
		}
	} finally {
		await machine.cleanup();
	}
});

test("the recovery of one backend does not take the task of a worker of another backend", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);

		/* Another session opens the same state directory. It may read the
		   records of the workers, but it holds no task of them. */
		const other = machine.newHost({
			stateDir: machine.dir,
			sessionId: "session-other",
			processId: 4343,
			processStartedAt: "2026-02-02T00:00:00.000Z",
		});
		try {
			const restored = other.rt.readRegistry();
			assert.equal(restored.alive.length, 3, "the other session holds no three workers");

			for (const job of restored.alive) {
				const owner = readOwnership(other.rt.openDb(), taskKey(job.id)).owner;
				assert.ok(owner, `the task of worker ${job.id} has no owner`);
				assert.equal(owner.sessionId, OWN, `another session owns the task of worker ${job.id}`);
				assert.equal(owner.phase, "active", `the task of worker ${job.id} is not active`);
			}
		} finally {
			await other.cleanup();
		}

		/* The first host holds every worker of every backend. */
		for (const id of [started.omp, started.claude, started.codex]) {
			assert.equal(machine.rt.jobs.get(id)?.id, id, `the first host lost the worker ${id}`);
		}
	} finally {
		await machine.cleanup();
	}
});

test("the recovery of the launch attempts creates no second worker", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		await startThreeBackends(machine);
		const launches = machine.launches;

		const second = machine.newHost({
			stateDir: machine.dir,
			sessionId: OWN,
			processId: 4343,
			processStartedAt: "2026-02-02T00:00:00.000Z",
		});
		try {
			/* The process table of the machine names no worker, so every
			   attempt that a crash left open becomes unresolved. The
			   recovery never starts a second worker. */
			const outcomes = reconcileAttempts(second.rt, [], OWN, Date.now());
			assert.deepEqual(outcomes, [], "the recovery settled an attempt of a live worker");
			assert.equal(machine.launches, launches, "the recovery started a program");
		} finally {
			await second.cleanup();
		}
	} finally {
		await machine.cleanup();
	}
});

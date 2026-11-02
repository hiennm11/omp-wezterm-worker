/**
 * The resource exclusion of workers of different backends.
 *
 * A worker of the Claude Code backend and a worker of the Codex backend with
 * different session folders do not collide. A second worker on the same
 * checkout is refused, and the refusal names the first worker, whatever the
 * backend of the first worker.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readBackend } from "../extensions/lib/backend.ts";
import { createGroup, groupOfRun, reserveExecution } from "../extensions/lib/groups.ts";
import { registerResumeTool } from "../extensions/worker-tools/resume.ts";
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

test("a Claude worker and a Codex worker with different session folders do not collide", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const claude = machine.rt.jobs.get(started.claude);
		const codex = machine.rt.jobs.get(started.codex);
		assert.ok(claude, "the runtime holds no Claude worker");
		assert.ok(codex, "the runtime holds no Codex worker");
		assert.notEqual(claude.sessionDir, codex.sessionDir, "the two workers share one session folder");

		const claudeGroup = groupOfRun(machine.rt.openDb(), claude);
		const codexGroup = groupOfRun(machine.rt.openDb(), codex);
		assert.ok(claudeGroup, "the Claude worker holds no resource group");
		assert.ok(codexGroup, "the Codex worker holds no resource group");
		assert.notEqual(claudeGroup.id, codexGroup.id, "the two workers share one resource group");

		/* A second run of the group of the Codex worker is refused, and the
		   refusal names the holder of the group. */
		const claudeReservation = reserveExecution(
			machine.rt.openDb(),
			claudeGroup.id,
			started.claude,
			Date.now(),
		);
		assert.equal(claudeReservation.granted, true, "the Claude worker holds no group");
		const codexReservation = reserveExecution(machine.rt.openDb(), codexGroup.id, started.codex, Date.now());
		assert.equal(codexReservation.granted, true, "the Codex worker holds no group");

		const other = reserveExecution(machine.rt.openDb(), codexGroup.id, "wz-other", Date.now());
		assert.equal(other.granted, false, "a second run took the group of the Codex worker");
		assert.match(other.granted ? "" : other.reason, new RegExp(started.codex), "the refusal names no holder");
	} finally {
		await machine.cleanup();
	}
});

test("a second worker on the same checkout is refused and names the first worker", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);

		/* The group of the Claude worker holds one writer. The run of the
		   Claude worker holds it. */
		const claude = machine.rt.jobs.get(started.claude);
		assert.ok(claude, "the runtime holds no Claude worker");
		const group = groupOfRun(machine.rt.openDb(), claude);
		assert.ok(group, "the Claude worker holds no resource group");
		const held = reserveExecution(machine.rt.openDb(), group.id, started.claude, Date.now());
		assert.equal(held.granted, true, "the Claude worker holds no group");

		/* The Claude worker ends, but its group stays held, because the
		   pane of the run may still write into the shared transcript. A
		   second run of the group is refused, and the refusal names the
		   first worker. */
		const resume = toolOf(machine.rt, registerResumeTool, "resume");
		const ctx = toolCtx(machine.dir, OWN);
		const refused = await resume.execute("t2", { workerId: started.claude }, ctx);
		assert.equal(refused.isError, true, "the second run took the group of the first worker");
		assert.match(replyText(refused), new RegExp(started.claude), "the refusal names no first worker");
	} finally {
		await machine.cleanup();
	}
});

test("the refusal names the first worker of every backend", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);

		for (const backend of ["omp", "claude", "codex"] as const) {
			const first = machine.rt.jobs.get(started[backend]);
			assert.ok(first, `the runtime holds no ${backend} worker`);
			assert.equal(readBackend(first), backend, "the worker holds another backend");

			/* The group of the first worker holds one writer. A second run
			   of another backend on the same folder is refused, and the
			   refusal names the first worker. */
			const group = groupOfRun(machine.rt.openDb(), first);
			assert.ok(group, `the ${backend} worker holds no resource group`);
			const held = reserveExecution(machine.rt.openDb(), group.id, `holder-${backend}`, Date.now());
			assert.equal(held.granted, true, `the ${backend} worker holds no group`);

			const second = reserveExecution(machine.rt.openDb(), group.id, "wz-second", Date.now());
			assert.equal(second.granted, false, `a second run took the group of the ${backend} worker`);
			const reason = second.granted ? "" : second.reason;
			assert.match(
				reason,
				new RegExp(`holder-${backend}`),
				`the refusal names no holder of the ${backend} worker`,
			);
			assert.match(
				reason,
				/The resources of this task are used by run/,
				`the refusal of the ${backend} worker names no rule`,
			);
		}
	} finally {
		await machine.cleanup();
	}
});

test("a group of one backend does not block the group of another backend", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const db = machine.rt.openDb();

		/* A group of the Codex backend that no worker holds. */
		createGroup(db, "grp-codex-other", `${machine.dir}/sessions/wz-codex-other`, Date.now());
		const claude = machine.rt.jobs.get(started.claude);
		assert.ok(claude, "the runtime holds no Claude worker");
		const claudeGroup = groupOfRun(db, claude);
		assert.ok(claudeGroup, "the Claude worker holds no resource group");

		const first = reserveExecution(db, claudeGroup.id, started.claude, Date.now());
		assert.equal(first.granted, true, "the Claude worker holds no group");
		const second = reserveExecution(db, "grp-codex-other", "wz-codex-other", Date.now());
		assert.equal(second.granted, true, "the group of the Codex backend was blocked by the Claude worker");
	} finally {
		await machine.cleanup();
	}
});

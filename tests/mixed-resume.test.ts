/**
 * The resume of a worker of the Claude Code backend beside the other workers.
 *
 * A finished worker of the Claude Code backend resumes as a Claude Code
 * worker while the worker of the OMP backend and the worker of the Codex
 * backend are active. The resume calls the path of the Claude Code backend
 * only. The worker of the Codex backend keeps its thread, and the worker of
 * the OMP backend keeps its program.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readBackend } from "../extensions/lib/backend.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { registerResumeTool } from "../extensions/worker-tools/resume.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

import { mixedMachine, TASK, toolCtx, toolOf } from "./mixed-helpers.ts";

/** The session that owns the workers of the test. */
const OWN = "session-mixed";

/** The ids of the workers of the three backends. */
interface StartedWorkers {
	omp: string;
	claude: string;
	codex: string;
}

/** Start one worker of every backend and return their ids. */
async function startThreeBackends(machine: ReturnType<typeof mixedMachine>): Promise<StartedWorkers> {
	machine.rt.config.commsStandard = { mode: "off", minScore: 80 };
	/* The count of the request is a rule of its own. The resume of the
	   test must show the backend of the resumed worker. */
	machine.rt.config.maxLaunchesPerRequest = 0;
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

test("a finished Claude worker resumes as a Claude worker beside the other backends", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);

		/* The Claude worker of the test ends, so it can be resumed. */
		const claude = machine.rt.jobs.get(started.claude);
		assert.ok(claude, "the runtime holds no Claude worker");
		claude.status = "completed";
		claude.paneClosed = true;
		claude.paneId = null;

		const programs = machine.programs.length;
		const resume = toolOf(machine.rt, registerResumeTool, "resume");
		const ctx = toolCtx(machine.dir, OWN);
		const resumed = await resume.execute("t2", { workerId: started.claude }, ctx);
		assert.equal(resumed.isError, undefined, `the resume was refused: ${resumed.content[0]?.text}`);

		const newId = resumed.details.workerId as string;
		assert.notEqual(newId, started.claude, "the resume reused the id of the source run");
		const job = machine.rt.jobs.get(newId);
		assert.ok(job, "the runtime holds no resumed worker");
		assert.equal(readBackend(job), "claude", "the resumed worker is not a Claude worker");
		assert.equal(job.nativeSessionId, claude.nativeSessionId, "the resume lost the native session");

		/* The resume started the program of the Claude Code backend only.
		   The program of the worker of the OMP backend and the program of
		   the app server of Codex stayed untouched. */
		const startedPrograms = machine.programs.slice(programs);
		assert.deepEqual(startedPrograms, ["claude"], "the resume started a program of another backend");
		assert.equal(machine.rt.jobs.get(started.omp)?.status, "running", "the OMP worker ended");
		assert.equal(machine.rt.jobs.get(started.codex)?.status, "running", "the Codex worker ended");
	} finally {
		await machine.cleanup();
	}
});

test("a resume of a Claude worker does not end the workers of the other backends", async () => {
	const machine = mixedMachine({ sessionId: OWN });
	try {
		const started = await startThreeBackends(machine);
		const claude = machine.rt.jobs.get(started.claude);
		assert.ok(claude, "the runtime holds no Claude worker");
		await finalizeJob(machine.rt, claude, "completed", null, "the work of the task");

		const taskkills = machine.taskkills.length;
		const killed = machine.killedPanes.length;
		const resume = toolOf(machine.rt, registerResumeTool, "resume");
		const ctx = toolCtx(machine.dir, OWN);
		const resumed = await resume.execute("t2", { workerId: started.claude }, ctx);
		assert.equal(resumed.isError, undefined, `the resume was refused: ${resumed.content[0]?.text}`);

		assert.equal(machine.taskkills.length, taskkills, "the resume ended a program of Codex");
		assert.equal(machine.killedPanes.length, killed, "the resume closed a pane of another worker");
		assert.equal(machine.rt.jobs.get(started.omp)?.status, "running", "the OMP worker ended");
		assert.equal(machine.rt.jobs.get(started.codex)?.status, "running", "the Codex worker ended");
	} finally {
		await machine.cleanup();
	}
});

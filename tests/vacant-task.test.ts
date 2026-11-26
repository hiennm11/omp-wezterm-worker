/**
 * The claim of a vacant task.
 *
 * A finished worker keeps an ownership row in the phase active. The row
 * names a session that no longer runs. Another session must be able to
 * handle the events of that worker, so it claims the task on demand.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { createEvent } from "../extensions/lib/events.ts";
import type { JobStatus } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { claimVacantTask } from "../extensions/lib/vacant-task.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { registerCancelTool } from "../extensions/worker-tools/cancel.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";
import { registerResumeTool } from "../extensions/worker-tools/resume.ts";
import { registerSteerTool } from "../extensions/worker-tools/steer.ts";
import { fakeRuntime, makeJob, OLD_PID, OLD_START, ownerOf } from "./takeover-helpers.ts";

/** The session that calls the tool. */
const OWN = "session-new";

/** The session that holds the task. */
const OTHER = "session-old";

/** The refusal that the tools give for a task of another session. */
const REFUSAL = "Worker wz-1 belongs to session session-old (phase active). This session only reads it.";

/** A tool that the fake host records. */
interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, boolean: () => chain, object: () => chain } as never;
}

/** The tool that the extension registers. */
function toolOf(rt: WorkerRuntime, register: (deps: never) => void, name: string): FakeTool {
	const tools = new Map<string, FakeTool>();
	register({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set(name, tool),
		},
		rt,
		deliver: () => undefined,
	} as never);
	const tool = tools.get(name);
	assert.ok(tool, `the ${name} tool was not registered`);
	return tool;
}

/**
 * Write a run row.
 *
 * The row is real. A test must not set the fields of a fake.
 */
function seedRun(rt: WorkerRuntime, jobId: string, sessionDir: string, status: string): void {
	rt.openDb()
		.handle.prepare(
			`INSERT INTO runs (id, label, task, cwd, status, session_dir, created_at, finished_at)
			 VALUES (?, 'test', 'task', '/repo', ?, ?, 1000, 1100)`,
		)
		.run(jobId, status, sessionDir);
}

/**
 * A runtime, a worker and a task that another session owns.
 *
 * The run row holds the given status. The ownership row names a dead owner
 * process, so the task is vacant.
 */
function vacantCase(
	status = "completed",
	table: { starts: Record<number, string>; code: number } = { starts: {}, code: 0 },
	jobStatus: JobStatus = "completed",
): { rt: WorkerRuntime; dir: string; jobId: string } {
	const { rt, dir } = fakeRuntime({ starts: table.starts, code: table.code, panes: [] });
	rt.sessionId = OWN;
	const job = makeJob(dir, "wz-1", { status: jobStatus });
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), OTHER, OLD_PID, OLD_START, 1000);
	seedRun(rt, job.id, job.sessionDir, status);
	return { rt, dir, jobId: job.id };
}

/** Close the runtime and remove the state directory of a test. */
function finish(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

test("the ack of an event of an ended run of a dead owner succeeds", async () => {
	const { rt, dir, jobId } = vacantCase();
	try {
		const event = createEvent(
			rt.openDb(),
			"ev-1",
			"key-1",
			jobId,
			"result",
			"result",
			null,
			true,
			1200,
		).event;

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: jobId,
			eventId: event.id,
			disposition: "accepted",
		});

		assert.notEqual(result.isError, true);
		const owner = ownerOf(rt, jobId);
		assert.equal(owner?.sessionId, OWN);
		assert.equal(owner?.generation, 2);
	} finally {
		finish(rt, dir);
	}
});

test("the ack of an event of an ended run of a live owner is refused", async () => {
	const { rt, dir, jobId } = vacantCase("completed", { starts: { [OLD_PID]: OLD_START }, code: 0 });
	try {
		const event = createEvent(
			rt.openDb(),
			"ev-1",
			"key-1",
			jobId,
			"result",
			"result",
			null,
			true,
			1200,
		).event;

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: jobId,
			eventId: event.id,
			disposition: "accepted",
		});

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(ownerOf(rt, jobId)?.sessionId, OTHER);
	} finally {
		finish(rt, dir);
	}
});

test("the ack of an event of an ended run is refused when the process table cannot answer", async () => {
	const { rt, dir, jobId } = vacantCase("completed", { starts: {}, code: 1 });
	try {
		const event = createEvent(
			rt.openDb(),
			"ev-1",
			"key-1",
			jobId,
			"result",
			"result",
			null,
			true,
			1200,
		).event;

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: jobId,
			eventId: event.id,
			disposition: "accepted",
		});

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(ownerOf(rt, jobId)?.sessionId, OTHER);
	} finally {
		finish(rt, dir);
	}
});

test("the ack of an event of a running run of another session is refused", async () => {
	const { rt, dir, jobId } = vacantCase("running");
	try {
		const event = createEvent(
			rt.openDb(),
			"ev-1",
			"key-1",
			jobId,
			"result",
			"result",
			null,
			true,
			1200,
		).event;

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: jobId,
			eventId: event.id,
			disposition: "accepted",
		});

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(ownerOf(rt, jobId)?.sessionId, OTHER);
	} finally {
		finish(rt, dir);
	}
});

test("the cleanup of a vacant task claims the task", async () => {
	const { rt, dir, jobId } = vacantCase();
	try {
		const result = await toolOf(rt, registerCleanupTool, "cleanup").execute("t1", { workerId: jobId });

		assert.notEqual(result.isError, true);
		const owner = ownerOf(rt, jobId);
		assert.equal(owner?.sessionId, OWN);
		assert.equal(owner?.generation, 2);
	} finally {
		finish(rt, dir);
	}
});

test("the resume of a vacant task claims the task", async () => {
	const { rt, dir, jobId } = vacantCase();
	try {
		const result = await toolOf(rt, registerResumeTool, "resume").execute(
			"t1",
			{ workerId: jobId },
			undefined,
			undefined,
			{ sessionManager: { getSessionFile: () => null, getSessionId: () => OWN } },
		);

		const owner = ownerOf(rt, jobId);
		assert.equal(owner?.sessionId, OWN);
		assert.equal(owner?.generation, 2);
		assert.notEqual(result.content[0]?.text, REFUSAL);
	} finally {
		finish(rt, dir);
	}
});

test("the steer of a vacant task keeps the refusal", async () => {
	/* The local copy of the worker still says running, so the tool reaches
	   the gate of the authority. The shared run row says that the run ended. */
	const { rt, dir, jobId } = vacantCase("completed", { starts: {}, code: 0 }, "running");
	try {
		const result = await toolOf(rt, registerSteerTool, "steer").execute("t1", {
			workerId: jobId,
			message: "Focus on the parser only",
		});

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(ownerOf(rt, jobId)?.sessionId, OTHER);
	} finally {
		finish(rt, dir);
	}
});

test("the cancel of a vacant task keeps the refusal", async () => {
	/* The local copy of the worker still says running, so the tool reaches
	   the gate of the authority. The shared run row says that the run ended. */
	const { rt, dir, jobId } = vacantCase("completed", { starts: {}, code: 0 }, "running");
	try {
		const result = await toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: jobId });

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(ownerOf(rt, jobId)?.sessionId, OTHER);
	} finally {
		finish(rt, dir);
	}
});

test("two claims of one generation leave one owner", async () => {
	const { rt, dir, jobId } = vacantCase();
	try {
		const owner = ownerOf(rt, jobId);
		assert.ok(owner);
		const results = await Promise.all([claimVacantTask(rt, jobId, owner), claimVacantTask(rt, jobId, owner)]);
		const claimed = results.filter((result) => result?.claimed === true);
		assert.equal(claimed.length, 1);
		assert.equal(ownerOf(rt, jobId)?.generation, 2);
	} finally {
		finish(rt, dir);
	}
});

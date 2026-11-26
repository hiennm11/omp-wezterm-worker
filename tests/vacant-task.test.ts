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
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, readOwnership } from "../extensions/lib/ownership.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { fakeRuntime, makeJob, OLD_PID, OLD_START, ownerOf } from "./takeover-helpers.ts";

/** The session that calls the tool. */
const OWN = "session-new";

/** The session that holds the task. */
const OTHER = "session-old";

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
 * Write a run row of a run that ended.
 *
 * The row is real. A test must not set the fields of a fake.
 */
function seedEndedRun(rt: WorkerRuntime, jobId: string, sessionDir: string): void {
	rt.openDb()
		.handle.prepare(
			`INSERT INTO runs (id, label, task, cwd, status, session_dir, created_at, finished_at)
			 VALUES (?, 'test', 'task', '/repo', 'completed', ?, 1000, 1100)`,
		)
		.run(jobId, sessionDir);
}

test("the ack of an event of an ended run of a dead owner succeeds", async () => {
	const { rt, dir } = fakeRuntime({ starts: {}, code: 0, panes: [] });
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1", { status: "completed" });
		rt.jobs.set(job.id, job);
		acquireOwnership(rt.openDb(), taskKey(job.id), OTHER, OLD_PID, OLD_START, 1000);
		seedEndedRun(rt, job.id, job.sessionDir);
		const event = createEvent(rt.openDb(), "ev-1", "key-1", job.id, "result", "result", null, true, 1200).event;

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: job.id,
			eventId: event.id,
			disposition: "accepted",
		});

		assert.notEqual(result.isError, true);
		const owner = ownerOf(rt, job.id);
		assert.equal(owner?.sessionId, OWN);
		assert.equal(owner?.generation, 2);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

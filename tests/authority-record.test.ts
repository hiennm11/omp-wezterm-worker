/**
 * The authority check of the record tools and of the delivery.
 *
 * A session that does not hold the authority of a task may only read the
 * records of the task. The record tools refuse to write, and the delivery
 * sends no message.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeliver } from "../extensions/lib/deliver.ts";
import { deliveriesOfEvent } from "../extensions/lib/delivery.ts";
import { createEvent, readHandling } from "../extensions/lib/events.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { readResolution } from "../extensions/lib/resolution.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";
import { registerResolveTool } from "../extensions/worker-tools/resolve.ts";
import { makeJob } from "./takeover-helpers.ts";

/** The session that calls the tool. */
const OWN = "session-new";

/** The session that holds the task. */
const OTHER = "session-old";

/** The refusal that the control rule gives for a task of another session. */
const REFUSAL = "Worker wz-1 belongs to session session-old (phase active). This session only reads it.";

/** A tool that the fake host records. */
interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
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

/** A runtime with an empty state directory. */
function fakeRuntime(): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-record-"));
	const exec: RunFn = async () => ({ code: 0, stdout: "", stderr: "" });
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** The tool that the extension registers. */
function toolOf(rt: WorkerRuntime, register: (deps: ToolDeps) => void, name: string): FakeTool {
	const tools = new Map<string, FakeTool>();
	register({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set(name, tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get(name);
	assert.ok(tool, `the ${name} tool was not registered`);
	return tool;
}

/** The owner of the task of a worker. */
function seedOwner(rt: WorkerRuntime, jobId: string, sessionId: string): void {
	acquireOwnership(rt.openDb(), taskKey(jobId), sessionId, 900, "2026-10-22T08:00:00.000Z", 1000);
}

/** One event of a worker. A null run id gives an event that belongs to no task. */
function seedEvent(rt: WorkerRuntime, id: string, runId: string | null): void {
	createEvent(rt.openDb(), id, `key-${id}`, runId, "unknown_outcome", "unknown_outcome", null, true, 1000);
}

/** Close the runtime and remove the state directory of a test. */
function finish(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

/** The parameters of an acknowledgement. */
function ackParams(workerId: string, eventId: string): Record<string, unknown> {
	return { workerId, eventId, disposition: "accepted" };
}

/** The parameters of a resolution. */
function resolveParams(workerId: string, eventId: string): Record<string, unknown> {
	return {
		workerId,
		eventId,
		resolution: "incomplete",
		evidenceNote: "The worker stopped without a report.",
	};
}

/** A host that records the messages and the warnings of the delivery. */
interface FakeHost {
	pi: never;
	sent: string[];
	warnings: string[];
}

/** A host that records the messages and the warnings of the delivery. */
function fakeHost(): FakeHost {
	const sent: string[] = [];
	const warnings: string[] = [];
	return {
		pi: {
			zod: fakeZod(),
			registerTool: () => undefined,
			sendUserMessage: (text: string) => {
				sent.push(text);
			},
			sendMessage: (text: string) => {
				sent.push(text);
			},
			logger: {
				info: () => undefined,
				warn: (message: string) => {
					warnings.push(message);
				},
				error: () => undefined,
			},
		} as never,
		sent,
		warnings,
	};
}

test("the ack of a session that does not own the task is refused", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OTHER);
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", ackParams("wz-1", "ev-1"));

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(result.details.workerId, "wz-1");
		assert.equal(result.details.owner, OTHER);
		assert.equal(result.details.phase, "active");
		assert.equal(result.details.acknowledged, false);
		assert.equal(readHandling(rt.openDb(), "ev-1"), null);
	} finally {
		finish(rt, dir);
	}
});

test("the resolve of a session that does not own the task is refused", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OTHER);
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerResolveTool, "resolve").execute(
			"t1",
			resolveParams("wz-1", "ev-1"),
		);

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(result.details.workerId, "wz-1");
		assert.equal(result.details.owner, OTHER);
		assert.equal(result.details.phase, "active");
		assert.equal(result.details.resolved, false);
		assert.equal(readResolution(rt.openDb(), "ev-1"), null);
		assert.equal(readHandling(rt.openDb(), "ev-1"), null);
	} finally {
		finish(rt, dir);
	}
});

test("the ack checks the worker of the event, not the worker of the parameter", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OTHER);
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", ackParams("wz-2", "ev-1"));

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, REFUSAL);
		assert.equal(result.details.workerId, "wz-1");
		assert.equal(readHandling(rt.openDb(), "ev-1"), null);
	} finally {
		finish(rt, dir);
	}
});

test("the ack of the owner of the task is recorded", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", ackParams("wz-1", "ev-1"));

		assert.notEqual(result.isError, true);
		assert.equal(result.details.acknowledged, true);
		const handling = readHandling(rt.openDb(), "ev-1");
		assert.equal(handling?.disposition, "accepted");
		assert.equal(handling?.ownerId, OWN);
		assert.equal(handling?.ownerGeneration, 1);
	} finally {
		finish(rt, dir);
	}
});

test("the resolve of the owner of the task is recorded", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerResolveTool, "resolve").execute(
			"t1",
			resolveParams("wz-1", "ev-1"),
		);

		assert.notEqual(result.isError, true);
		assert.equal(result.details.resolved, true);
		const resolution = readResolution(rt.openDb(), "ev-1");
		assert.equal(resolution?.resolution, "incomplete");
		assert.equal(resolution?.ownerId, OWN);
		assert.equal(resolution?.ownerGeneration, 1);
		assert.equal(readHandling(rt.openDb(), "ev-1")?.disposition, "accepted");
	} finally {
		finish(rt, dir);
	}
});

test("the ack of an event without a worker is recorded", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OTHER);
		seedEvent(rt, "ev-1", null);

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", ackParams("wz-1", "ev-1"));

		assert.notEqual(result.isError, true);
		assert.equal(result.details.acknowledged, true);
		assert.equal(readHandling(rt.openDb(), "ev-1")?.disposition, "accepted");
	} finally {
		finish(rt, dir);
	}
});

test("the ack of a session without an identity is recorded", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = null;
		seedOwner(rt, "wz-1", OTHER);
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", ackParams("wz-1", "ev-1"));

		assert.notEqual(result.isError, true);
		assert.equal(result.details.acknowledged, true);
		assert.equal(readHandling(rt.openDb(), "ev-1")?.disposition, "accepted");
	} finally {
		finish(rt, dir);
	}
});

test("the ack of a task without an ownership row is recorded", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedEvent(rt, "ev-1", "wz-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", ackParams("wz-1", "ev-1"));

		assert.notEqual(result.isError, true);
		assert.equal(result.details.acknowledged, true);
		assert.equal(readHandling(rt.openDb(), "ev-1")?.disposition, "accepted");
	} finally {
		finish(rt, dir);
	}
});

test("the delivery of a session that does not own the task sends no message", () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		seedOwner(rt, job.id, OTHER);
		const host = fakeHost();

		createDeliver(host.pi, rt)(job);

		assert.equal(host.sent.length, 0);
		assert.equal(deliveriesOfEvent(rt.openDb(), job.id).length, 0);
		assert.equal(host.warnings.length, 1);
		assert.match(host.warnings[0] ?? "", /wz-1/);
		assert.match(host.warnings[0] ?? "", /session-old/);
	} finally {
		finish(rt, dir);
	}
});

test("the delivery of the owner of the task sends the message", () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		seedOwner(rt, job.id, OWN);
		const host = fakeHost();

		createDeliver(host.pi, rt)(job);

		assert.equal(host.sent.length, 1);
		const attempts = deliveriesOfEvent(rt.openDb(), job.id);
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0]?.state, "sent");
		assert.equal(host.warnings.length, 0);
	} finally {
		finish(rt, dir);
	}
});

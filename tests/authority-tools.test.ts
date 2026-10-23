/**
 * The authority check of the tools that control a worker.
 *
 * A session that does not hold the authority of a task may only read the
 * records of the task. The tools refuse the action, and the refusal names
 * the session that holds the task.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, beginRelease, commitRelease, readOwnership } from "../extensions/lib/ownership.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerCancelTool } from "../extensions/worker-tools/cancel.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";
import { registerReleaseTool } from "../extensions/worker-tools/release.ts";
import { registerResumeTool } from "../extensions/worker-tools/resume.ts";
import { registerSteerTool } from "../extensions/worker-tools/steer.ts";
import { makeJob } from "./takeover-helpers.ts";

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

/** The options of the fake WezTerm. */
interface FakeOptions {
	/** The gate that holds the close of a pane. */
	gate?: Promise<void>;
	/** Runs when a close of a pane arrives. */
	onClose?: () => void;
}

/** A runtime whose WezTerm records every call. */
function fakeRuntime(options: FakeOptions = {}): {
	rt: WorkerRuntime;
	dir: string;
	calls: string[][];
} {
	const dir = mkdtempSync(join(tmpdir(), "wt-authority-"));
	const calls: string[][] = [];
	const exec: RunFn = async (_bin, args) => {
		calls.push(args);
		if (args.includes("kill-pane")) {
			options.onClose?.();
			if (options.gate) await options.gate;
		}
		if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir, calls };
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

/** Close the runtime and remove the state directory of a test. */
function finish(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

test("the cancel of a worker of another session is refused", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OTHER);

		const result = await toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: job.id });

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
		);
		assert.equal(result.details.workerId, "wz-1");
		assert.equal(result.details.owner, OTHER);
		assert.equal(result.details.phase, "active");
		assert.equal(
			calls.some((args) => args.includes("kill-pane")),
			false,
		);
		assert.equal(job.status, "running");
	} finally {
		finish(rt, dir);
	}
});

test("the steer of a worker of another session is refused", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OTHER);

		const result = await toolOf(rt, registerSteerTool, "steer").execute("t1", {
			workerId: job.id,
			message: "Focus on the parser only",
		});

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
		);
		assert.equal(result.details.owner, OTHER);
		assert.equal(
			calls.some((args) => args.includes("send-text")),
			false,
		);
	} finally {
		finish(rt, dir);
	}
});

test("the cleanup of a worker of another session is refused", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1", { status: "completed" });
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OTHER);

		const result = await toolOf(rt, registerCleanupTool, "cleanup").execute("t1", { workerId: job.id });

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
		);
		assert.equal(result.details.phase, "active");
		assert.equal(existsSync(job.sessionDir), true);
	} finally {
		finish(rt, dir);
	}
});

test("the resume of a worker of another session is refused", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1", { status: "completed" });
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OTHER);

		const result = await toolOf(rt, registerResumeTool, "resume").execute(
			"t1",
			{ workerId: job.id },
			undefined,
			undefined,
			{ sessionManager: { getSessionFile: () => null, getSessionId: () => OWN } },
		);

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
		);
		assert.equal(rt.requestLaunches.length, 0);
	} finally {
		finish(rt, dir);
	}
});

test("a session without an identity cancels a worker", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = null;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: job.id });

		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /cancelled/);
		assert.equal(job.status, "cancelled");
	} finally {
		finish(rt, dir);
	}
});

test("a worker without an ownership row is cancelled", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: job.id });

		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /cancelled/);
		assert.equal(job.status, "cancelled");
	} finally {
		finish(rt, dir);
	}
});

test("a release that starts during a cancel waits for the cancel", async () => {
	const gate = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const { rt, dir } = fakeRuntime({ gate: gate.promise, onClose: closed.resolve });
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);

		const cancelling = toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: job.id });
		await closed.promise;

		const released = await toolOf(rt, registerReleaseTool, "release").execute("t2", { workerId: job.id });

		assert.equal(released.isError, true);
		assert.deepEqual(released.details.unsettledActions, ["cancel:wz-1"]);
		assert.equal(released.details.released, false);
		assert.equal(readOwnership(rt.openDb(), taskKey(job.id)).owner?.phase, "releasing");

		gate.resolve();
		await cancelling;
	} finally {
		finish(rt, dir);
	}
});

test("a cancel of a task that this session is releasing is refused", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		beginRelease(rt.openDb(), taskKey(job.id), OWN, 1, 1100);

		const result = await toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: job.id });

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, "This session is releasing worker wz-1.");
		assert.equal(result.details.phase, "releasing");
		assert.equal(
			calls.some((args) => args.includes("kill-pane")),
			false,
		);
		assert.equal(job.status, "running");
	} finally {
		finish(rt, dir);
	}
});

test("a cancel of a task that this session released is refused", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		beginRelease(rt.openDb(), taskKey(job.id), OWN, 1, 1100);
		commitRelease(rt.openDb(), taskKey(job.id), OWN, 1, 1200);

		const result = await toolOf(rt, registerCancelTool, "cancel").execute("t1", { workerId: job.id });

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, "This session released worker wz-1.");
		assert.equal(result.details.phase, "released");
		assert.equal(
			calls.some((args) => args.includes("kill-pane")),
			false,
		);
		assert.equal(job.status, "running");
	} finally {
		finish(rt, dir);
	}
});

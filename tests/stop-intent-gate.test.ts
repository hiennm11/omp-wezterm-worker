/**
 * The gate that a pending stop intent puts before the control tools.
 *
 * A pending intent means that a destructive command may have run. The pane of
 * the worker may already be closed. The control tools refuse until the
 * reconciliation settles the intent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { recordStopIntent } from "../extensions/lib/stop-intent.ts";
import { reconcileStopIntents } from "../extensions/lib/stop-reconcile.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { cleanupTool, fakeWezterm, jobOf, runtimeFor } from "./group-holder-helpers.ts";

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

test("the cleanup refuses a run with a pending stop intent and goes on after the confirmation", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [] }).exec);
	rt.sessionId = "s1";
	const job = jobOf("wz-1", { paneId: null, status: "completed" });
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "s1", 1, "t", 1000);
	recordStopIntent(rt.openDb(), "stop-wz-1", job.id, "cancelled", "Cancelled by the main agent", 1001);

	const refused = await cleanupTool(rt).execute("t1", { workerId: "wz-1" });

	assert.equal(refused.isError, true);
	assert.match(refused.content[0]?.text ?? "", /wz-1/);
	assert.match(refused.content[0]?.text ?? "", /wezterm_worker_cancel/);

	await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	const done = await cleanupTool(rt).execute("t2", { workerId: "wz-1" });

	assert.notEqual(done.isError, true);
	assert.match(done.content[0]?.text ?? "", /transcript directory removed/);
});

test("the status shows the pending stop intent of a run", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [] }).exec);
	rt.sessionId = "s1";
	const job = jobOf("wz-2", { paneId: null, status: "completed" });
	rt.jobs.set(job.id, job);
	recordStopIntent(rt.openDb(), "stop-wz-2", job.id, "cancelled", "Cancelled by the main agent", 1001);

	const tools = new Map<string, FakeTool>();
	registerStatusTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("status", tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("status");
	assert.ok(tool, "the status tool was not registered");

	const result = await tool.execute("t1", {});

	assert.match(result.content[0]?.text ?? "", /Stop intent: pending/);
});

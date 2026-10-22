/**
 * The events that wait for the owner.
 *
 * A native worker raises an event when it needs the person. The owner must
 * find the event, because the acknowledgement needs its id.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEvent } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";

/** A host that records the tools that the extension registers. */
interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
		extra?: unknown,
		fifth?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
}

function fakeHost(): { tools: Map<string, FakeTool> } {
	return { tools: new Map<string, FakeTool>() };
}

test("the status lists the events that wait for the owner", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-events-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const job: Job = {
			id: "wz-ev1",
			label: "test",
			task: "task",
			cwd: "/repo",
			model: null,
			tools: null,
			placement: "split",
			sessionDir: join(stateDir, "wz-ev1"),
			sessionFile: null,
			worktreePath: null,
			worktreeBranch: null,
			worktreeOrigin: null,
			timeoutMs: 0,
			idleTimeoutMs: 0,
			closePaneOnFinish: true,
			...freshRunState(0),
			status: "running",
			paneId: 3,
		};
		rt.jobs.set(job.id, job);

		const db = rt.openDb();
		createEvent(
			db,
			"ev-wz-ev1-approval-1-permission_request",
			"key-1",
			job.id,
			"permission_request",
			"permission_request",
			JSON.stringify({ callId: "call-1", tool: "Bash" }),
			true,
			Date.now(),
		);

		const host = fakeHost();
		registerStatusTool({
			pi: {
				zod: fakeZod(),
				registerTool: (tool: FakeTool) => host.tools.set("status", tool),
			} as never,
			rt,
			deliver: () => undefined,
		});
		const tool = host.tools.get("status");
		assert.ok(tool, "the status tool was not registered");
		const result = await tool.execute("t1", {});
		const events = (result.details.events ?? []) as { id: string; condition: string }[];
		assert.equal(events.length, 1);
		assert.equal(events[0]?.condition, "permission_request");
		assert.match(result.content[0]?.text ?? "", /Events that wait for you/);
		assert.match(result.content[0]?.text ?? "", /ev-wz-ev1-approval-1-permission_request/);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

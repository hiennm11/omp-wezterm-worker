/**
 * The completion blocker in the status tool.
 *
 * A worker that reported completion but still holds an outstanding execution
 * shows the blocker. The owner reads the line and knows why the worker did
 * not end.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { syncExecutions } from "../extensions/lib/ledger-sync.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { writeTranscript } from "./execution-helpers.ts";

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

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

test("the status prints the completion blocker of a worker that cannot end", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-blocker-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const sessionDir = join(stateDir, "sessions", "wz-blk");
		const file = writeTranscript(sessionDir, "a.jsonl", [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
			},
		]);
		const job: Job = {
			id: "wz-blk",
			label: "test",
			task: "task",
			cwd: "/repo",
			model: null,
			tools: null,
			placement: "split",
			sessionDir,
			sessionFile: file,
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
		syncExecutions(rt.openDb(), job.id, readCallLedger(file), 0, 1000);
		appendReport(sessionDir, {
			runId: job.id,
			cycleId: null,
			state: "completed",
			result: "THE-ANSWER",
			dependency: null,
			resumeCondition: null,
			needs: null,
			detail: null,
		});

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
		assert.match(result.content[0]?.text ?? "", /Completion blocked: /);
		assert.match(result.content[0]?.text ?? "", /execution\(s\)/);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

/** A finished worker of the given id and age. */
function finishedJob(id: string, createdAt: number): Job {
	return {
		id,
		label: id,
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join("/repo", id),
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(createdAt),
		status: "completed",
		createdAt,
	};
}

/** The status tool of a runtime that holds the given workers. */
function statusToolOf(rt: WorkerRuntime): FakeTool {
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
	return tool;
}

test("the status hides the old workers and names the count", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-hidden-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		for (let index = 0; index < 12; index += 1) {
			const job = finishedJob(`wz-old-${index}`, index);
			rt.jobs.set(job.id, job);
		}

		const result = await statusToolOf(rt).execute("t1", {});

		assert.match(result.content[0]?.text ?? "", /2 older worker\(s\) are hidden/);
		assert.equal(result.details.hidden, 2);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the status shows one old worker when the call names it", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-hidden-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		for (let index = 0; index < 12; index += 1) {
			const job = finishedJob(`wz-old-${index}`, index);
			rt.jobs.set(job.id, job);
		}

		const result = await statusToolOf(rt).execute("t1", { workerId: "wz-old-0" });

		assert.match(result.content[0]?.text ?? "", /wz-old-0/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /older worker\(s\) are hidden/);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

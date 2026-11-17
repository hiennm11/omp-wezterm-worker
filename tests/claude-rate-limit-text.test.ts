/**
 * The text of the rate limit of a Claude Code worker.
 *
 * The owner reads the text of the event. The text names the reset time and
 * says that the run still runs and that the owner decides.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { formatRateLimit } from "../extensions/lib/claude-rate-limit.ts";
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

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

/** A running native worker. */
function nativeJob(sessionDir: string): Job {
	const launchedAt = Date.now() - 61_000;
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(launchedAt),
		status: "running",
		paneId: "w1:p7",
		runtime: "herdr",
		backend: "claude",
		startedAt: launchedAt,
	};
}

test("the text of a rate limit names the reset time and the owner decides", () => {
	const text = formatRateLimit(
		JSON.stringify({ resetsAt: Date.UTC(2026, 10, 17, 12, 30), rateLimitType: "five_hour", apiErrorStatus: 429 }),
	);
	assert.match(text, /five_hour/);
	assert.match(text, /The run still runs\./);
	assert.match(text, /Cancel the worker or wait\./);
});

test("the text of a rate limit without a reset time says that the time is unknown", () => {
	const text = formatRateLimit(JSON.stringify({ resetsAt: null, rateLimitType: null, apiErrorStatus: 429 }));
	assert.match(text, /the reset time is unknown/);
	assert.match(text, /The run still runs\./);
});

test("the status shows the text of the rate limit", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-limit-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const job = nativeJob(join(stateDir, "sessions", "wz-1"));
		rt.jobs.set(job.id, job);
		createEvent(
			rt.openDb(),
			"ev-wz-1-rate-limit-turn-1-rate_limited",
			"wz-1|rate-limit-turn-1|rate_limited",
			job.id,
			"rate_limited",
			"rate_limited",
			JSON.stringify({ resetsAt: 1792135800000, rateLimitType: "five_hour", apiErrorStatus: 429 }),
			true,
			Date.now(),
		);

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
		assert.match(result.content[0]?.text ?? "", /rate_limited/);
		assert.match(result.content[0]?.text ?? "", /five_hour/);
		assert.match(result.content[0]?.text ?? "", /The run still runs\./);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

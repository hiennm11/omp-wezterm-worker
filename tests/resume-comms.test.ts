/**
 * The communication check of the resume tool.
 *
 * A resume carries a follow-up instruction for the worker. The instruction
 * is a text that the main session exchanges with a worker, so the resume
 * scores it like a steer. A low score refuses the resume before it reaches
 * a pane. A resume without a message scores nothing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CommsSettings } from "../extensions/lib/comms-check.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";
import { registerResumeTool } from "../extensions/worker-tools/resume.ts";

const ENFORCE: CommsSettings = { mode: "enforce", minScore: 80 };
const SKILL = join(tmpdir(), "an-ste100-skill-folder");
const MESSAGE = "Continue with the parser work now.";
const LOW_SCORE = 44;

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

/** The JSON that the skill checker prints for one document. */
function skillJson(score: number): string {
	return JSON.stringify({
		minScore: 80,
		documents: [
			{
				path: "x.md",
				score,
				totalSentences: 1,
				skippedSentences: 0,
				pass: score >= 80,
				findings: [],
			},
		],
	});
}

/** A finished worker that a resume can reopen. */
function finishedJob(id: string): Job {
	return {
		id,
		label: "test",
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
		...freshRunState(0),
		status: "completed",
		paneId: null,
	};
}

/** A runtime whose checker scores the texts that the resume sends. */
function fakeRuntime(score: number): {
	rt: WorkerRuntime;
	dir: string;
	checkerCalls: string[][];
} {
	const dir = mkdtempSync(join(tmpdir(), "wt-resume-comms-"));
	const checkerCalls: string[][] = [];
	const exec: RunFn = async (_bin, args) => {
		const answer: RunResult = { code: score >= 80 ? 0 : 1, stdout: skillJson(score), stderr: "" };
		if (args[0]?.endsWith("cli.js")) {
			checkerCalls.push(args);
			return answer;
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.commsStandard = ENFORCE;
	rt.config.ste100Skill = SKILL;
	return { rt, dir, checkerCalls };
}

/** The resume tool of a runtime. */
function toolOf(rt: WorkerRuntime): FakeTool {
	const tools = new Map<string, FakeTool>();
	registerResumeTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("resume", tool),
		} as never,
		rt,
		deliver: () => undefined,
	} satisfies ToolDeps);
	const tool = tools.get("resume");
	assert.ok(tool, "the resume tool was not registered");
	return tool;
}

/** The context of a call that has no session identity. */
const CONTEXT = { sessionManager: { getSessionFile: () => null, getSessionId: () => null } };

test("a resume refuses a message that scores below the minimum", async () => {
	const { rt, dir, checkerCalls } = fakeRuntime(LOW_SCORE);
	try {
		const job = finishedJob("wz-1");
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt).execute(
			"t1",
			{ workerId: job.id, message: MESSAGE },
			undefined,
			undefined,
			CONTEXT,
		);

		assert.equal(result.isError, true);
		assert.equal(result.details.refused, "commsStandard");
		assert.match(result.content[0]?.text ?? "", /communication check refused/i);
		assert.equal(checkerCalls.length, 1);
		assert.equal(rt.jobs.size, 1);
		assert.equal(rt.requestLaunches.length, 0);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume with a clean message goes on", async () => {
	const { rt, dir, checkerCalls } = fakeRuntime(95);
	try {
		const job = finishedJob("wz-2");
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt).execute(
			"t1",
			{ workerId: job.id, message: MESSAGE },
			undefined,
			undefined,
			CONTEXT,
		);

		assert.notEqual(result.details.refused, "commsStandard");
		assert.equal(checkerCalls.length, 1);
		assert.equal(rt.requestLaunches.length, 1);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume without a message runs no checker command", async () => {
	const { rt, dir, checkerCalls } = fakeRuntime(95);
	try {
		const job = finishedJob("wz-3");
		rt.jobs.set(job.id, job);

		await toolOf(rt).execute("t1", { workerId: job.id }, undefined, undefined, CONTEXT);

		assert.equal(checkerCalls.length, 0);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

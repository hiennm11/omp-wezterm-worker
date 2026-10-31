/**
 * The resume of a Codex worker.
 *
 * A Codex worker resumes in the same thread of Codex. The thread keeps its
 * history, so the worker comes back with the task and the answers that it
 * already produced.
 *
 * The tests use the fake runtime of a Codex spawn. The fake answers the pane
 * list, the process table and the client of the app server.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { readGroup } from "../extensions/lib/groups.ts";
import type { Job } from "../extensions/lib/job.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { resumeCodexWorker } from "../extensions/lib/resume-codex.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import {
	cleanupRuntime,
	endSource,
	fakeWezterm,
	finishedJob,
	freshRuntime,
	RESUMED_ID,
	SOURCE_ID,
	seedGroup,
	sessionDirOf,
	startSource,
	THREAD_ID,
} from "./codex-resume-helpers.ts";
import { type CodexFake, codexFake } from "./codex-spawn-helpers.ts";

/** The instruction that the owner gives to the resumed worker. */
const MESSAGE = "Call the report tool with the result RESUME-OK.";

/**
 * The resume of a source run.
 *
 * The helper runs the real function with the fake runtime. It returns the
 * job of the new run and the fake, so a test can read both.
 */
async function resume(
	fake: CodexFake,
	source: Job,
	message?: string,
): Promise<{ job: Job; fake: CodexFake }> {
	const job = await resumeCodexWorker(
		fake.rt,
		{ jobId: RESUMED_ID, source, threadId: THREAD_ID, message },
		{ connect: fake.connect, serverWaitMs: 100 },
	);
	return { job, fake };
}

/** Close the bridges of the runs and remove the directory of the test. */
async function cleanup(fake: CodexFake): Promise<void> {
	await fake.closeBridges();
	fake.rt.closeDb();
	rmSync(fake.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

test("a resume with a message resumes the thread of the source run", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		const before = fake.clientCalls.length;

		const { job } = await resume(fake, source, MESSAGE);

		assert.equal(job.status, "running", `the resume failed: ${job.error}`);
		const calls = fake.clientCalls.slice(before);
		const resumed = calls.find((call) => call.method === "thread/resume");
		assert.ok(resumed, "the resume called no thread/resume");
		assert.equal(resumed.params.threadId, THREAD_ID);
		assert.equal(
			calls.some((call) => call.method === "thread/start"),
			false,
			"the resume started a thread",
		);
		assert.equal(
			calls.some((call) => call.method === "thread/name/set"),
			false,
			"the resume named the thread",
		);
		assert.equal(job.nativeSessionId, THREAD_ID);
	} finally {
		await cleanup(fake);
	}
});

test("a resume with a message starts one turn with the message", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		const before = fake.clientCalls.length;

		await resume(fake, source, MESSAGE);

		const turns = fake.clientCalls.slice(before).filter((call) => call.method === "turn/start");
		assert.equal(turns.length, 1, "the resume did not start one turn");
		const input = turns[0].params.input as Array<{ text: string }>;
		assert.equal(input[0].text, MESSAGE);
	} finally {
		await cleanup(fake);
	}
});

test("a resume without a message starts no turn", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		const before = fake.clientCalls.length;

		const { job } = await resume(fake, source);

		assert.equal(job.status, "running", `the resume failed: ${job.error}`);
		const calls = fake.clientCalls.slice(before);
		assert.equal(
			calls.some((call) => call.method === "turn/start"),
			false,
			"the resume started a turn",
		);
		assert.equal(
			calls.some((call) => call.method === "thread/resume"),
			true,
			"the resume called no thread/resume",
		);
	} finally {
		await cleanup(fake);
	}
});

test("a resume is refused while the pane of the TUI is open", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		fake.panes.add(12);
		const before = fake.order.length;

		const { job } = await resume(fake, source, MESSAGE);

		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /pane 12/);
		const group = readGroup(fake.rt.openDb(), `grp-${SOURCE_ID}`);
		assert.equal(group?.executionHolder, null, "the refused resume reserved a group");
		assert.equal(fake.order.length, before, "the refused resume started a program");
	} finally {
		await cleanup(fake);
	}
});

test("a resume is refused while the pane of the app server is open", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		fake.panes.add(11);
		const before = fake.order.length;

		const { job } = await resume(fake, source, MESSAGE);

		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /pane 11/);
		assert.equal(fake.order.length, before, "the refused resume started a program");
	} finally {
		await cleanup(fake);
	}
});

test("a resume is refused when the pane list cannot be read", async () => {
	const fake = codexFake({ listCode: 1 });
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		const before = fake.order.length;

		const { job } = await resume(fake, source, MESSAGE);

		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /pane list cannot be read/);
		assert.equal(fake.order.length, before, "the refused resume started a program");
	} finally {
		await cleanup(fake);
	}
});

test("a resume that fails at thread/resume leaves no pane and no program", async () => {
	const fake = codexFake({ failClientMethod: "thread/resume", failClientConnect: 2 });
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		const kills = fake.taskkills.length;

		const { job } = await resume(fake, source, MESSAGE);

		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /did not resume/);
		assert.equal(fake.panes.size, 0, "a pane stayed open");
		assert.equal(fake.taskkills.length, kills + 1, "the program of the app server stayed alive");
		assert.equal(fake.closedClients.includes(2), true, "the client of the app server stayed open");
	} finally {
		await cleanup(fake);
	}
});

test("the new run has its own run id", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);

		const { job } = await resume(fake, source, MESSAGE);

		assert.notEqual(job.id, source.id);
		assert.equal(fake.rt.jobs.get(source.id)?.id, source.id);
		assert.equal(fake.rt.jobs.get(job.id)?.id, job.id);
	} finally {
		await cleanup(fake);
	}
});

test("a report of the source run does not finish the new run", async () => {
	const fake = codexFake();
	try {
		const source = await startSource(fake);
		await endSource(fake, source);
		const { job } = await resume(fake, source, MESSAGE);
		const sourceBridge = fake.rt.bridges.get(source.id);
		assert.ok(sourceBridge, "the source run holds no bridge");

		const response = await fetch(`${sourceBridge.baseUrl}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${sourceBridge.token}`,
			},
			body: JSON.stringify({
				backend: "codex",
				runId: source.id,
				source: "report",
				payload: { state: "completed", result: "OLD-RUN" },
			}),
		});
		assert.equal(response.status, 202, "the bridge refused the report");

		assert.equal(fake.rt.claudeStates.get(source.id)?.reports.length, 1, "the source run lost the report");
		assert.equal(fake.rt.claudeStates.get(job.id)?.reports.length, 0, "the report reached the new run");
		assert.equal(
			fake.rt.jobs.get(job.id)?.status,
			"running",
			"the report of the source run finished the new run",
		);
	} finally {
		await cleanup(fake);
	}
});

test("a resume of an OMP worker starts no Codex program", async () => {
	const { exec, programs } = fakeWezterm();
	const { rt, dir } = freshRuntime(exec);
	try {
		const sessionDir = sessionDirOf(dir, "wz-omp-1");
		const source = finishedJob("wz-omp-1", sessionDir);
		rt.jobs.set(source.id, source);
		seedGroup(rt, "grp-wz-omp-1", sessionDir);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-omp-2" });

		assert.equal(resumed.status, "running", `the resume failed: ${resumed.error}`);
		assert.equal(programs.includes(rt.config.ompBin), true, "the resume started no OMP program");
		assert.equal(programs.includes(rt.config.codexBin), false, "the resume started a Codex program");
	} finally {
		await cleanupRuntime(rt, dir);
	}
});

test("a resume of a Claude worker starts no Codex program", async () => {
	const { exec, programs } = fakeWezterm();
	const { rt, dir } = freshRuntime(exec);
	try {
		const sessionDir = sessionDirOf(dir, "wz-claude-1");
		const source = finishedJob("wz-claude-1", sessionDir, "claude");
		rt.jobs.set(source.id, source);
		seedGroup(rt, "grp-wz-claude-1", sessionDir);

		const resumed = await resumeClaudeWorker(rt, {
			jobId: "wz-claude-2",
			source,
			sessionId: "sess-1",
		});

		assert.equal(resumed.status, "running", `the resume failed: ${resumed.error}`);
		assert.equal(programs.includes(rt.config.claudeBin), true, "the resume started no Claude program");
		assert.equal(programs.includes(rt.config.codexBin), false, "the resume started a Codex program");
	} finally {
		await cleanupRuntime(rt, dir);
	}
});

/**
 * The approval policy that the extension sends to the app server of Codex.
 *
 * The setting `codex.approvalPolicy` names the policy of the worker. The
 * extension sends the field `approvalPolicy` in the request `thread/start`
 * and in the request `turn/start`. A missing setting sends no field, so the
 * worker keeps the policy of the user.
 *
 * The tests use the fake runtime of a Codex spawn. The fake records every
 * request of the client of the app server.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import { type CodexFake, codexFake } from "./codex-spawn-helpers.ts";

/**
 * The launch of one Codex worker.
 *
 * The helper runs the real function with the fake runtime. It returns the
 * job and the fake, so a test can read both.
 */
async function launch(policy: string | null): Promise<{ job: Job; fake: CodexFake }> {
	const fake = codexFake();
	fake.rt.config.codexApprovalPolicy = policy as never;
	try {
		const job = await spawnCodexWorker(
			fake.rt,
			{ jobId: "wz-codex-approval", task: "Reply with the single word OK.", cwd: fake.dir },
			{ connect: fake.connect, serverWaitMs: 100 },
		);
		return { job, fake };
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
}

/** The request of the fake that carries a method. */
function callOf(fake: CodexFake, method: string): { method: string; params: Record<string, unknown> } {
	const call = fake.clientCalls.find((entry) => entry.method === method);
	assert.ok(call, `the launch sent no request ${method}`);
	return call;
}

test("the setting decides the policy of the thread request", async () => {
	const withPolicy = await launch("untrusted");
	assert.equal(withPolicy.job.status, "running", `the launch failed: ${withPolicy.job.error}`);
	const started = callOf(withPolicy.fake, "thread/start");
	assert.equal(started.params.approvalPolicy, "untrusted");

	const withoutPolicy = await launch(null);
	assert.equal(withoutPolicy.job.status, "running", `the launch failed: ${withoutPolicy.job.error}`);
	const plain = callOf(withoutPolicy.fake, "thread/start");
	assert.equal("approvalPolicy" in plain.params, false);
});

test("the setting decides the policy of the turn request", async () => {
	const withPolicy = await launch("untrusted");
	assert.equal(withPolicy.job.status, "running", `the launch failed: ${withPolicy.job.error}`);
	const turn = callOf(withPolicy.fake, "turn/start");
	assert.equal(turn.params.approvalPolicy, "untrusted");

	const withoutPolicy = await launch(null);
	assert.equal(withoutPolicy.job.status, "running", `the launch failed: ${withoutPolicy.job.error}`);
	const plain = callOf(withoutPolicy.fake, "turn/start");
	assert.equal("approvalPolicy" in plain.params, false);
});

test("only the thread request and the turn request carry the policy", async () => {
	const { job, fake } = await launch("untrusted");
	assert.equal(job.status, "running", `the launch failed: ${job.error}`);
	const carriers = fake.clientCalls.filter((call) => "approvalPolicy" in call.params);
	assert.deepEqual(
		carriers.map((call) => call.method),
		["thread/start", "turn/start"],
	);
});

test("the launch fails when the setting names no policy", async () => {
	const fake = codexFake();
	try {
		const job = await spawnCodexWorker(
			fake.rt,
			{ jobId: "wz-codex-bad-policy", task: "Reply with the single word OK.", cwd: fake.dir },
			{ connect: fake.connect, serverWaitMs: 100 },
		);
		assert.equal(job.status, "failed", "the launch accepted an unknown policy");
		assert.match(job.error ?? "", /approvalPolicy/);
		assert.equal(fake.panes.size, 0, "a pane stayed open");
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
		rmSync(fake.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
});

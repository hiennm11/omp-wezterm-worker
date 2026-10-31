/**
 * The report channel of a Codex worker.
 *
 * A Codex worker reports through the bridge of its run. The test checks that
 * a report reaches the state of the run and that a failed launch leaves no
 * bridge behind.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { REPORTING_CONTRACT } from "../extensions/lib/bootstrap-prompt.ts";
import type { Job } from "../extensions/lib/job.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import { type CodexFake, type CodexFakeOptions, codexFake } from "./codex-spawn-helpers.ts";

/**
 * The launch of one Codex worker.
 *
 * The helper runs the real function with the fake runtime. It returns the
 * job and the fake, so a test can read both.
 */
async function launch(options: CodexFakeOptions = {}): Promise<{ job: Job; fake: CodexFake }> {
	const fake = codexFake(options);
	const job = await spawnCodexWorker(
		fake.rt,
		{
			jobId: "wz-codex-report",
			task: "Report the task state.",
			cwd: fake.dir,
		},
		{ connect: fake.connect, serverWaitMs: options.serverWaitMs ?? 100 },
	);
	return { job, fake };
}

/** Close the runtime of a test and remove its directory. */
async function cleanup(fake: CodexFake): Promise<void> {
	await fake.closeBridges();
	fake.rt.closeDb();
	rmSync(fake.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

test("a report that reaches the bridge appears in the reports of the run", async () => {
	const { job, fake } = await launch();
	try {
		const state = fake.rt.claudeStates.get(job.id);
		assert.ok(state, "the run holds no state");
		const bridge = fake.rt.bridges.get(job.id);
		assert.ok(bridge, "the run holds no bridge");

		/* The report server of Codex posts the report to the bridge of the
		   run. The bridge hands every observation to the state of the run. */
		const response = await fetch(`${bridge.baseUrl}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${bridge.token}`,
			},
			body: JSON.stringify({
				backend: "codex",
				runId: job.id,
				source: "report",
				payload: { state: "completed", result: "SMOKE-OK" },
			}),
		});
		assert.equal(response.status, 202, "the bridge refused the report");

		const reports = fake.rt.claudeStates.get(job.id)?.reports ?? [];
		assert.equal(reports.length, 1, "the report did not reach the state of the run");
		assert.equal(reports[0].state, "completed");
		assert.equal(reports[0].result, "SMOKE-OK");
	} finally {
		await cleanup(fake);
	}
});

test("a failed launch closes the bridge and clears both maps", async () => {
	const { job, fake } = await launch({ failClientMethod: "thread/start" });
	try {
		assert.equal(job.status, "failed");
		assert.equal(fake.rt.bridges.has(job.id), false, "the bridge stayed in the map");
		assert.equal(fake.rt.claudeStates.has(job.id), false, "the state stayed in the map");
	} finally {
		await cleanup(fake);
	}
});

test("a missing TUI closes the bridge and clears both maps", async () => {
	const { job, fake } = await launch({ failTuiLaunch: true });
	try {
		assert.equal(job.status, "failed");
		assert.equal(fake.rt.bridges.has(job.id), false, "the bridge stayed in the map");
		assert.equal(fake.rt.claudeStates.has(job.id), false, "the state stayed in the map");
	} finally {
		await cleanup(fake);
	}
});

test("the thread of the worker carries the reporting contract", async () => {
	const { fake } = await launch();
	try {
		const started = fake.clientCalls.find((call) => call.method === "thread/start");
		assert.ok(started, "the thread did not start");
		assert.equal(started.params.developerInstructions, REPORTING_CONTRACT);
	} finally {
		await cleanup(fake);
	}
});

test("the app server of the worker loads the report server", async () => {
	const { fake } = await launch();
	try {
		const server = fake.weztermCalls.find((call) => call.includes("app-server"));
		assert.ok(server, "the app server did not start");
		const text = server.join(" ");
		assert.match(text, /mcp_servers\.wezterm_worker_report\.command/);
		assert.match(text, /approval_mode="approve"/);
	} finally {
		await cleanup(fake);
	}
});

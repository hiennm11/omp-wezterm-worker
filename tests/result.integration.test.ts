/**
 * The `wezterm_worker_result` tool.
 *
 * The tool reads a finished worker. The tests here use a worker that a real
 * run has already finished, so the result is a fact and not a fixture.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHost, detailString, removeDir, sessionContext, waitFor } from "./harness.ts";

function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN = hasProgram("omp") && hasProgram("wezterm");

test("the result tool returns the worker's answer", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-result-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-result-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: "Reply with the single word PONG and nothing else.",
			cwd: repo,
			label: "result",
		});
		const workerId = detailString(spawned.details, "workerId") ?? "";

		const finished = await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", { workerId });
				return /COMPLETED|FAILED|CANCELLED/.test(host.text(status));
			},
			180_000,
			1000,
		);
		assert.ok(finished, "The worker did not finish");

		const result = await host.call("wezterm_worker_result", { workerId });
		assert.equal(result.isError, undefined);
		assert.match(host.text(result), /PONG/, "The result tool did not return the worker's answer");
		assert.equal(detailString(result.details, "workerId"), workerId);
		assert.equal(detailString(result.details, "status"), "completed");
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

test("the result tool reports an unknown worker", async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-result-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-result-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const result = await host.call("wezterm_worker_result", { workerId: "no-such-worker" });
		assert.equal(result.isError, true);
		assert.match(host.text(result), /Unknown worker id/);
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

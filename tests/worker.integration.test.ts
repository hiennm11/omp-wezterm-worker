/**
 * The worker lifecycle, with a real worker in a real pane.
 *
 * This test spawns a real `omp` process in a real WezTerm pane. It needs both
 * programs. On a machine without them the test reports that it cannot run,
 * instead of reporting a pass.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readUsageTotals } from "../extensions/lib/usage.ts";
import { createHost, removeDir, sessionContext, waitFor } from "./harness.ts";

/** The programs the test needs. */
function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN = hasProgram("omp") && hasProgram("wezterm");

/** Build a small git repository for the worker to work in. */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-integration-"));
	writeFileSync(join(dir, "README.md"), "# integration\n", "utf8");
	spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

/** The pane ids that WezTerm reports now. */
function currentPanes(): number[] {
	const out = execFileSync("wezterm", ["cli", "list", "--format", "json"], { encoding: "utf8" });
	const panes = JSON.parse(out) as Array<{ pane_id: number }>;
	return panes.map((p) => p.pane_id);
}

test("the worker lifecycle, with a real worker", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = makeRepo();
	const stateDir = mkdtempSync(join(tmpdir(), "wt-integration-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		// --- spawn ---
		const spawned = await host.call("wezterm_spawn_worker", {
			task: "Reply with the single word PONG and nothing else.",
			cwd: repo,
			label: "integration",
		});
		const details = spawned.details as { workerId?: string; paneId?: number };
		const workerId = details?.workerId ?? "";
		const paneId = details?.paneId ?? -1;
		assert.ok(workerId, "The spawn tool returned no worker id");
		assert.ok(paneId > 0, "The spawn tool returned no pane id");

		// --- the worker finishes ---
		const finished = await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", { workerId });
				return /COMPLETED|FAILED|CANCELLED/.test(host.text(status));
			},
			180_000,
			1000,
		);
		const status = await host.call("wezterm_worker_status", { workerId });
		assert.ok(finished, `The worker did not finish: ${host.text(status)}`);
		assert.match(host.text(status), /COMPLETED/, `The worker did not complete: ${host.text(status)}`);

		// --- the result is delivered ---
		const delivered = await waitFor(() => host.delivered.some((t) => t.includes(workerId)), 20_000, 250);
		assert.ok(delivered, "The extension did not deliver the result");
		assert.ok(
			host.delivered.some((t) => t.includes(workerId) && t.includes("PONG")),
			"The delivered result did not carry the worker's answer",
		);

		// --- the pane is closed ---
		const paneGone = await waitFor(() => !currentPanes().includes(paneId), 20_000, 500);
		assert.ok(paneGone, "The worker pane is still open after the worker finished");

		// --- the registry records the worker ---
		const registry = JSON.parse(readFileSync(join(stateDir, "registry.json"), "utf8")) as {
			jobs: Array<{ id: string; paneId: number | null; status: string }>;
		};
		const entry = registry.jobs.find((j) => j.id === workerId);
		assert.ok(entry, "The registry does not hold the worker");
		assert.equal(entry?.paneId, paneId);
		assert.equal(entry?.status, "completed");

		// --- a new host sees the worker ---
		const second = createHost({ stateDir, cwd: repo });
		await second.fire("session_start", sessionContext(repo));
		const listed = await second.call("wezterm_worker_status", {});
		assert.ok(
			host.text(listed).includes(workerId) || second.text(listed).includes(workerId),
			"A new process does not list the worker from the registry",
		);

		// --- the worker can be resumed and answers the new message ---
		const resumed = await second.call("wezterm_worker_resume", {
			workerId,
			message: "Now reply with the single word RESUMED and nothing else.",
		});
		const resumeDetails = resumed.details as { workerId?: string };
		const resumedId = resumeDetails?.workerId ?? "";
		assert.ok(resumedId && resumedId !== workerId, "The resume tool returned no new worker id");

		const resumedFinished = await waitFor(
			async () => {
				const status = await second.call("wezterm_worker_status", { workerId: resumedId });
				return /COMPLETED|FAILED|CANCELLED/.test(second.text(status));
			},
			180_000,
			1000,
		);
		const resumeStatus = await second.call("wezterm_worker_status", { workerId: resumedId });
		assert.ok(resumedFinished, `The resumed worker did not finish: ${second.text(resumeStatus)}`);
		assert.match(second.text(resumeStatus), /COMPLETED/);

		const resumeDelivered = await waitFor(
			() => second.delivered.some((t) => t.includes(resumedId)),
			20_000,
			250,
		);
		assert.ok(resumeDelivered, "The extension did not deliver the resumed result");
		assert.ok(
			second.delivered.some((t) => t.includes("RESUMED")),
			"The resumed worker did not answer the new message",
		);

		// --- the resumed worker reports only its own turns ---
		const resumeStatusResult = await second.call("wezterm_worker_status", { workerId: resumedId });
		const usageDetails = resumeStatusResult.details as {
			workers?: Array<{ usage?: { totals?: { calls?: number } } }>;
		};
		const reportedCalls = usageDetails.workers?.[0]?.usage?.totals?.calls ?? 0;
		// The resumed worker writes into the folder of the worker it resumes.
		const allCalls = readUsageTotals(join(stateDir, "sessions", workerId)).calls;
		assert.ok(reportedCalls > 0, "The resumed worker reported no usage");
		assert.ok(
			reportedCalls < allCalls,
			`The baseline was not subtracted: ${reportedCalls} of ${allCalls} calls`,
		);

		await second.cleanup();
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

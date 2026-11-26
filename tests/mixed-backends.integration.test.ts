/**
 * One OMP session with a real OMP worker and a real Claude Code worker.
 *
 * The two workers run at the same time. Each one writes a file in its own
 * worktree and reports its task as completed. The test then checks the
 * acknowledgement and the cleanup of each worker apart from the other:
 * the cleanup refuses a result that nobody acknowledged, keeps a worktree
 * that holds changes, and a force removes it while the branch survives.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { answerTrustDialogs } from "./claude-trust-helpers.ts";
import { createHost, detailString, removeDir, sessionContext, type TestHost, waitFor } from "./harness.ts";

/** The programs the test needs. */
function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN =
	hasProgram("omp") && hasProgram("claude") && hasProgram("herdr") && process.env.HERDR_ENV === "1";

/** The wait for both workers to end. */
const FINISH_WAIT_MS = 300_000;

/** The statuses that end a worker. */
const FINAL_STATUSES = ["completed", "failed", "cancelled"];

/** Build a small git repository for the workers to work in. */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-mixed-"));
	writeFileSync(join(dir, "README.md"), "# mixed backends\n", "utf8");
	spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

/** The task of a worker. It takes a while, so the two workers overlap. */
function taskFor(label: string): string {
	return (
		`Write the numbers 1 to 12 into a file named count-${label}.txt in the current working ` +
		"directory, one number per line, with the write tool, one number at a time. " +
		"Then create a file named worker-output.txt in the same directory and put the word DONE in it. " +
		"Then report the task as completed with wezterm_worker_report."
	);
}

/** The status row of one worker. */
interface Row {
	status: string;
	backend: string;
}

/** Read the status row of one worker, or null when the row is missing. */
async function readRow(host: TestHost, workerId: string): Promise<Row | null> {
	const result = await host.call("wezterm_worker_status", { workerId });
	const workers =
		result.details && typeof result.details === "object" && "workers" in result.details
			? result.details.workers
			: null;
	const row = Array.isArray(workers) ? workers[0] : null;
	if (!row || typeof row !== "object") return null;
	const status = "status" in row && typeof row.status === "string" ? row.status : "unknown";
	const backend = "backend" in row && typeof row.backend === "string" ? row.backend : "unknown";
	return { status, backend };
}

/** The changed paths of a checkout. */
function changedPaths(cwd: string): string[] {
	const out = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
	return out.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

test("an OMP worker and a Claude worker run in one session and are handled apart", {
	skip: !CAN_RUN ? "omp, claude or herdr is not available, or this is not a Herdr session" : false,
}, async () => {
	const repo = makeRepo();
	const stateDir = mkdtempSync(join(tmpdir(), "wt-mixed-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));
	const stopAnswering = answerTrustDialogs();

	try {
		const claude = await host.call("wezterm_spawn_worker", {
			task: taskFor("claude"),
			cwd: repo,
			label: "mixed-claude",
			backend: "claude",
			model: "haiku",
			isolated: true,
			placement: "tab",
		});
		const claudeId = detailString(claude.details, "workerId") ?? "";
		const claudeTree = detailString(claude.details, "worktreePath") ?? "";
		assert.ok(claudeId, `The Claude spawn returned no worker id: ${host.text(claude)}`);
		assert.ok(
			claudeTree,
			`The Claude worker got no worktree: ${host.text(claude)} ${JSON.stringify(claude.details)}`,
		);

		const omp = await host.call("wezterm_spawn_worker", {
			task: taskFor("omp"),
			cwd: repo,
			label: "mixed-omp",
			isolated: true,
			placement: "tab",
		});
		const ompId = detailString(omp.details, "workerId") ?? "";
		const ompTree = detailString(omp.details, "worktreePath") ?? "";
		assert.ok(ompId, `The OMP spawn returned no worker id: ${host.text(omp)}`);
		assert.ok(ompTree, `The OMP worker got no worktree: ${host.text(omp)} ${JSON.stringify(omp.details)}`);
		assert.notEqual(ompTree, claudeTree, "The two workers share one worktree");

		// --- both workers run at the same time, each on its own backend ---
		let overlapped = false;
		let ompRow: Row | null = null;
		let claudeRow: Row | null = null;
		const finished = await waitFor(
			async () => {
				ompRow = await readRow(host, ompId);
				claudeRow = await readRow(host, claudeId);
				if (ompRow?.status === "running" && claudeRow?.status === "running") overlapped = true;
				return (
					ompRow !== null &&
					claudeRow !== null &&
					FINAL_STATUSES.includes(ompRow.status) &&
					FINAL_STATUSES.includes(claudeRow.status)
				);
			},
			FINISH_WAIT_MS,
			1000,
		);
		const rows = `omp=${JSON.stringify(ompRow)} claude=${JSON.stringify(claudeRow)}`;
		assert.ok(finished, `The workers did not both finish: ${rows}`);
		assert.ok(overlapped, `The two workers were never running at the same time: ${rows}`);
		assert.deepEqual(ompRow, { status: "completed", backend: "OMP" }, rows);
		assert.deepEqual(claudeRow, { status: "completed", backend: "Claude Code" }, rows);

		// --- each worker left its own work in its own worktree ---
		for (const [name, tree] of [
			["OMP", ompTree],
			["Claude", claudeTree],
		] as const) {
			assert.ok(existsSync(join(tree, "worker-output.txt")), `The ${name} worker output is gone`);
			assert.ok(changedPaths(tree).length > 0, `The ${name} worktree has no changes`);
		}

		// --- the cleanup refuses a result that nobody acknowledged ---
		const ompEvent = `ev-${ompId}-result`;
		const claudeEvent = `ev-${claudeId}-result`;
		const ompRefused = await host.call("wezterm_worker_cleanup", { workerId: ompId });
		const claudeRefused = await host.call("wezterm_worker_cleanup", { workerId: claudeId });
		assert.equal(ompRefused.isError, true, "The cleanup passed an unacknowledged OMP result");
		assert.equal(claudeRefused.isError, true, "The cleanup passed an unacknowledged Claude result");
		assert.match(host.text(ompRefused), new RegExp(ompEvent));
		assert.match(host.text(claudeRefused), new RegExp(claudeEvent));

		// --- the acknowledgement of one worker does not settle the other ---
		const ackOmp = await host.call("wezterm_worker_ack", {
			workerId: ompId,
			eventId: ompEvent,
			disposition: "accepted",
		});
		assert.notEqual(ackOmp.isError, true, `The OMP acknowledgement failed: ${host.text(ackOmp)}`);
		const claudeStillRefused = await host.call("wezterm_worker_cleanup", { workerId: claudeId });
		assert.equal(
			claudeStillRefused.isError,
			true,
			"The acknowledgement of the OMP result settled the Claude result",
		);

		const ackClaude = await host.call("wezterm_worker_ack", {
			workerId: claudeId,
			eventId: claudeEvent,
			disposition: "accepted",
		});
		assert.notEqual(ackClaude.isError, true, `The Claude acknowledgement failed: ${host.text(ackClaude)}`);

		// --- the cleanup keeps a worktree that holds changes ---
		for (const [name, id, tree] of [
			["OMP", ompId, ompTree],
			["Claude", claudeId, claudeTree],
		] as const) {
			const kept = await host.call("wezterm_worker_cleanup", { workerId: id });
			assert.ok(existsSync(tree), `The cleanup removed the ${name} worktree that holds changes`);
			assert.match(host.text(kept), /kept/, `The ${name} cleanup did not report that it kept the work`);
			assert.match(host.text(kept), /worker-output\.txt/, `The ${name} cleanup did not list the changes`);
		}

		// --- a force removes each worktree, and each branch survives ---
		for (const [id, tree] of [
			[ompId, ompTree],
			[claudeId, claudeTree],
		] as const) {
			await host.call("wezterm_worker_cleanup", { workerId: id, force: true });
			assert.ok(!existsSync(tree), "The cleanup with force did not remove a worktree");
		}
		const branches = spawnSync("git", ["branch", "--list", "omp/worker/*"], { cwd: repo, encoding: "utf8" });
		assert.ok(branches.stdout.includes(`omp/worker/${ompId}`), "The branch of the OMP worker is gone");
		assert.ok(branches.stdout.includes(`omp/worker/${claudeId}`), "The branch of the Claude worker is gone");
	} finally {
		stopAnswering();
		await host.cleanup();
		await removeDir(repo);
	}
});

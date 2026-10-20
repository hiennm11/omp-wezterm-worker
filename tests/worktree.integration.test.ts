/**
 * The isolated worktree, with a real worker.
 *
 * The worker writes a file in its own checkout. The test then checks that the
 * checkout survives the worker, and that cleanup keeps it while it holds
 * changes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHost, sessionContext, waitFor } from "./harness.ts";

/** The programs the test needs. */
function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN = hasProgram("omp") && hasProgram("wezterm");

/** Build a small git repository for the worker to work in. */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-worktree-"));
	writeFileSync(join(dir, "README.md"), "# worktree\n", "utf8");
	spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

/** The changed paths in a checkout. */
function changedPaths(cwd: string): string[] {
	const out = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
	return out.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

test("the worktree survives the worker and cleanup keeps the changes", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = makeRepo();
	const stateDir = mkdtempSync(join(tmpdir(), "wt-worktree-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task:
				"Create a file named worker-output.txt in the current working directory. " +
				"Put the word DONE in it. Use the write tool. Then stop.",
			cwd: repo,
			isolated: true,
			label: "worktree",
		});
		const details = spawned.details as { workerId?: string; worktreePath?: string };
		const workerId = details?.workerId ?? "";
		const worktreePath = details?.worktreePath ?? "";
		assert.ok(workerId, "The spawn tool returned no worker id");
		assert.ok(worktreePath, "The spawn tool returned no worktree path");

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

		// --- the worktree survives the worker ---
		assert.ok(
			existsSync(worktreePath),
			"The worktree was removed when the worker finished. The extension must keep it.",
		);
		assert.ok(
			existsSync(join(worktreePath, "worker-output.txt")),
			"The worker output is gone. The worktree was removed too early.",
		);
		assert.ok(
			changedPaths(worktreePath).length > 0,
			"The worktree has no changes, so the dirty check has nothing to find",
		);

		// --- cleanup without force keeps the dirty worktree ---
		const kept = await host.call("wezterm_worker_cleanup", { workerId });
		assert.ok(existsSync(worktreePath), "Cleanup removed a worktree that holds changes");
		assert.match(host.text(kept), /kept/, "Cleanup did not report that it kept the worktree");
		assert.match(host.text(kept), /worker-output\.txt/, "Cleanup did not list the changed path");

		// --- cleanup with force removes it, and the branch survives ---
		const forced = await host.call("wezterm_worker_cleanup", { workerId, force: true });
		assert.ok(!existsSync(worktreePath), "Cleanup with force did not remove the worktree");
		assert.match(host.text(forced), /branch kept/, "Cleanup did not report that it kept the branch");

		const branches = spawnSync("git", ["branch", "--list", "omp/worker/*"], {
			cwd: repo,
			encoding: "utf8",
		});
		assert.ok(
			branches.stdout.includes(`omp/worker/${workerId}`),
			"The branch of the worker is gone. Commits must survive the worktree.",
		);
	} finally {
		host.cleanup();
		rmSync(repo, { recursive: true, force: true });
	}
});

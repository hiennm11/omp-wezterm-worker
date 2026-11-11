/**
 * The isolated worktree of a native worker.
 *
 * A native worker writes files like any other worker. The isolation must
 * give it its own checkout, so two workers never edit the same one.
 *
 * The test starts a real Claude Code worker. It needs Claude Code and
 * Herdr. The Claude Code backend does not run on Herdr yet, so both tests
 * report that they cannot run, instead of reporting a pass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHost, removeDir, sessionContext } from "./harness.ts";

/** The Claude Code backend does not run on Herdr yet. */
const CAN_RUN = false;

/** Build a small git repository for the worker to work in. */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-native-"));
	writeFileSync(join(dir, "README.md"), "# native worktree\n", "utf8");
	spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

test("a native worker gets its own worktree", {
	skip: !CAN_RUN ? "The Claude Code backend does not run on Herdr yet. Issue 171 has it." : false,
}, async () => {
	const repo = makeRepo();
	const stateDir = mkdtempSync(join(tmpdir(), "wt-native-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: "Read README.md. Do not change anything.",
			cwd: repo,
			label: "native-worktree",
			backend: "claude",
			model: "haiku",
			isolated: true,
			placement: "tab",
		});
		const details = spawned.details as {
			workerId?: string;
			cwd?: string;
			worktreePath?: string;
		};
		assert.ok(details.workerId, "the spawn returned no worker id");
		assert.ok(details.worktreePath, "the native worker got no worktree");
		assert.notEqual(details.cwd, repo, "the native worker still works in the shared checkout");
		assert.ok(existsSync(details.worktreePath), "the worktree of the native worker does not exist");
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

test("a native worker finds its bridge through the handover file", {
	skip: !CAN_RUN ? "The Claude Code backend does not run on Herdr yet. Issue 171 has it." : false,
}, async () => {
	const repo = makeRepo();
	const stateDir = mkdtempSync(join(tmpdir(), "wt-native-handover-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: "Read README.md. Do not change anything.",
			cwd: repo,
			label: "native-handover",
			backend: "claude",
			model: "haiku",
			placement: "tab",
		});
		const details = spawned.details as { workerId?: string };
		assert.ok(details.workerId, "the spawn returned no worker id");
		const file = join(stateDir, "sessions", details.workerId, ".wezterm-worker-bridge.json");
		assert.ok(existsSync(file), "the handover file of the native worker does not exist");
		const handover = JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string };
		assert.match(String(handover.url), /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.ok(handover.token, "the handover file holds no token");
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

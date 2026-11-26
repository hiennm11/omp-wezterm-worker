/**
 * The empty directory that git leaves after it removes a worktree.
 *
 * On Windows `git worktree remove` deletes the files and the registration,
 * then fails on the directory while a process holds it as its working
 * directory. The tests start a real process in that directory.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { removeWorktree } from "../extensions/lib/worktree.ts";

const WINDOWS_ONLY =
	process.platform === "win32" ? false : "a held working directory blocks removal on Windows only";

/** A git that fails to remove the directory, and lists the worktree or not. */
function gitThatLeavesTheDirectory(path: string, options: { listed: boolean }): RunFn {
	return async (_bin, args) => {
		if (args[0] === "worktree" && args[1] === "remove") {
			return { code: 1, stdout: "", stderr: `failed to delete '${path}': Permission denied` };
		}
		if (args[0] === "worktree" && args[1] === "list") {
			const listed = options.listed ? `worktree ${path}\n\n` : "";
			return { code: 0, stdout: `worktree /repo\n\n${listed}`, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

/** A directory that holds the worktree directory, which is empty. */
function emptyWorktreeDir(): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), "wt-leftover-"));
	const path = join(root, "wz-1");
	mkdirSync(path);
	return { root, path };
}

/** A process that holds the directory as its working directory. */
function holder(cwd: string): ChildProcess {
	return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		cwd,
		stdio: "ignore",
		windowsHide: true,
	});
}

/** End a process and wait until it is gone. */
function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("close", () => resolve());
	child.kill();
	return promise;
}

test("an empty directory that a process holds is removed after the process ends", {
	skip: WINDOWS_ONLY,
}, async () => {
	const { root, path } = emptyWorktreeDir();
	const child = holder(path);
	try {
		setTimeout(() => void stop(child), 700);
		const rt = createRuntime(gitThatLeavesTheDirectory(path, { listed: false }));
		const outcome = await removeWorktree(rt, "/repo", path, 15_000);
		assert.deepEqual(outcome, { removed: true, error: null });
		assert.equal(existsSync(path), false);
	} finally {
		await stop(child);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a directory that a process holds past the wait is reported as not removed", {
	skip: WINDOWS_ONLY,
}, async () => {
	const { root, path } = emptyWorktreeDir();
	const child = holder(path);
	try {
		const rt = createRuntime(gitThatLeavesTheDirectory(path, { listed: false }));
		const outcome = await removeWorktree(rt, "/repo", path, 400);
		assert.equal(outcome.removed, false);
		assert.match(outcome.error ?? "", /Permission denied/);
		assert.equal(existsSync(path), true);
	} finally {
		await stop(child);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a directory that still holds a file is never removed", async () => {
	const { root, path } = emptyWorktreeDir();
	try {
		writeFileSync(join(path, "worker-output.txt"), "DONE\n", "utf8");
		const rt = createRuntime(gitThatLeavesTheDirectory(path, { listed: false }));
		const outcome = await removeWorktree(rt, "/repo", path, 400);
		assert.equal(outcome.removed, false);
		assert.equal(existsSync(join(path, "worker-output.txt")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an empty directory that git still lists as a worktree is kept", async () => {
	const { root, path } = emptyWorktreeDir();
	try {
		const rt = createRuntime(gitThatLeavesTheDirectory(path, { listed: true }));
		const outcome = await removeWorktree(rt, "/repo", path, 400);
		assert.equal(outcome.removed, false);
		assert.equal(existsSync(path), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { removeDir } from "./remove-dir.ts";

/**
 * Start a process that holds the directory as its working directory.
 *
 * Windows refuses to remove a directory that a process holds. The process
 * lives until the test ends it, so no timer guesses how long it holds.
 */
async function holdDirectory(dir: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
		cwd: dir,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
	await once(child.stdout, "data");
	return child;
}

/** End the process and wait until the operating system reports it gone. */
async function release(child: ChildProcess): Promise<void> {
	const exited = once(child, "exit");
	child.kill();
	await exited;
}

test("removeDir waits for a process that holds the directory and then removes it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-removedir-"));
	const holder = await holdDirectory(dir);
	try {
		// The call starts its first attempt before it returns, and the holder
		// still lives, so the directory is there when the call returns.
		const removal = removeDir(dir);
		assert.equal(existsSync(dir), true, "The directory is gone while a process holds it");
		await release(holder);
		await removal;
		assert.equal(existsSync(dir), false, "The directory is still there after removeDir");
	} finally {
		holder.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("removeDir does not throw when a holder outlasts the wait", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-removedir-"));
	const holder = await holdDirectory(dir);
	try {
		// This test measures the end of the wait, so it needs real elapsed
		// time. A fake clock cannot release a handle that the operating
		// system holds.
		await removeDir(dir, { waitMs: 150 });
		assert.equal(existsSync(dir), true, "The directory cannot be gone while a process holds it");
	} finally {
		await release(holder);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("removeDir removes a directory that no process holds", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-removedir-"));
	await removeDir(dir);
	assert.equal(existsSync(dir), false);
});

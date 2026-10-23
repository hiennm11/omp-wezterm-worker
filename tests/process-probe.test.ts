/**
 * The process probe.
 *
 * The probe runs a real PowerShell script. The tests of `owner.test.ts` use a
 * fake `exec`, so they cannot see a script that fails for a gone process.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";

import { readProcessStart } from "../extensions/lib/process-table.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";

const SKIP_REASON = "The process probe needs the PowerShell of Windows.";
const SKIP = process.platform === "win32" ? false : SKIP_REASON;

/** A child node process that runs the given code. */
function startChild(code: string): ChildProcess {
	return spawn(process.execPath, ["-e", code], { stdio: "ignore", windowsHide: true });
}

/** The process id of a child process. */
function pidOf(child: ChildProcess): number {
	assert.ok(child.pid, "The child process has no process id.");
	return child.pid;
}

/** Wait until a child process ended. */
function ended(child: ChildProcess): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	child.on("close", () => resolve());
	return promise;
}

test("the probe reads the start time of a live process", { skip: SKIP }, async () => {
	/* The child holds a real timer, so that it stays alive while the probe
	   reads its start time. */
	const child = startChild("setTimeout(() => {}, 30000)");
	try {
		const rt = createRuntime();
		const pid = pidOf(child);
		const first = await readProcessStart(rt, pid);
		assert.equal(first.ok, true);
		assert.notEqual(first.ok ? first.startedAt : null, null);
		const second = await readProcessStart(rt, pid);
		assert.deepEqual(second, first);
	} finally {
		child.kill();
	}
});

test("the probe reports a gone process as gone", { skip: SKIP }, async () => {
	const child = startChild("process.exit(0)");
	const pid = pidOf(child);
	await ended(child);
	const rt = createRuntime();
	const result = await readProcessStart(rt, pid);
	assert.equal(result.ok, true);
	assert.equal(result.ok ? result.startedAt : "failed", null);
});

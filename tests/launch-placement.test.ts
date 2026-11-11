/**
 * The place of a new worker pane.
 *
 * A new tab belongs to the workspace of the main session, not to the
 * workspace that the client happens to focus. A split goes next to the pane
 * of the main session. Both values come from the environment of the Herdr
 * pane, so a test needs no pane.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { launchProgram } from "../extensions/lib/pane-launch.ts";
import { workspaceOf } from "../extensions/lib/pane-runtime.ts";
import type { RunResult } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** A job of a worker that runs in Herdr. */
function worker(placement: "tab" | "split", sessionDir: string): Job {
	return {
		id: "wz-place",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement,
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		paneId: null,
		runtime: "herdr",
	};
}

/** A runtime that records the Herdr calls and opens a pane for each one. */
function runtimeOf(calls: string[][]): WorkerRuntime {
	const exec = async (bin: string, args: string[]): Promise<RunResult> => {
		calls.push([bin, ...args]);
		if (args[0] === "tab" && args[1] === "create") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { root_pane: { pane_id: "w5:p9", tab_id: "w5:t9" } } }),
				stderr: "",
			};
		}
		if (args[0] === "pane" && args[1] === "split") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w5:p8", tab_id: "w5:t1" } } }),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = mkdtempSync(join(tmpdir(), "wt-place-"));
	rt.sourcePaneId = "w5:p1";
	rt.sourceWorkspaceId = "w5";
	return rt;
}

test("the workspace of a pane id is the part before the colon", () => {
	assert.equal(workspaceOf("w5:p1"), "w5");
	assert.equal(workspaceOf("w4:p12"), "w4");
	assert.equal(workspaceOf(null), null);
	assert.equal(workspaceOf("nonsense"), null);
	assert.equal(workspaceOf(":p1"), null);
});

test("a tab opens in the workspace of the main session", async () => {
	const calls: string[][] = [];
	const rt = runtimeOf(calls);
	const sessionDir = mkdtempSync(join(tmpdir(), "wt-place-session-"));
	try {
		const failure = await launchProgram(rt, worker("tab", sessionDir), "omp", ["--no-title"]);
		assert.equal(failure, null);
		const create = calls.find((args) => args[1] === "tab" && args[2] === "create");
		assert.ok(create, "the launch did not create a tab");
		const at = create.indexOf("--workspace");
		assert.notEqual(at, -1, "the tab did not name a workspace");
		assert.equal(create[at + 1], "w5");
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("a split names the pane of the main session", async () => {
	const calls: string[][] = [];
	const rt = runtimeOf(calls);
	const sessionDir = mkdtempSync(join(tmpdir(), "wt-place-session-"));
	try {
		const failure = await launchProgram(rt, worker("split", sessionDir), "omp", ["--no-title"]);
		assert.equal(failure, null);
		const split = calls.find((args) => args[1] === "pane" && args[2] === "split");
		assert.ok(split, "the launch did not split a pane");
		const at = split.indexOf("--pane");
		assert.notEqual(at, -1, "the split did not name a pane");
		assert.equal(split[at + 1], "w5:p1");
		assert.equal(split.includes("--current"), false, "the split still depends on the focus");
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

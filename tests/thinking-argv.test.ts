/**
 * The thinking level in the argv of an OMP worker.
 *
 * OMP has the flag `--thinking <level>`. The extension asks for the level
 * that the user chose. A job without a level asks for nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { ompArgv } from "../extensions/lib/spawn.ts";

/** A job that holds a thinking level. */
function jobWith(thinking: string | null): Job {
	return {
		id: "wz-1",
		label: "worker",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		thinking,
		status: "queued",
		paneId: null,
		tabId: null,
		windowId: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: false,
		createdAt: 0,
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
		worktreeDirty: null,
		pendingStop: null,
		lastActivityAt: 0,
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		usageBaseline: null,
		steers: 0,
		lastTranscriptSize: 0,
		paneClosed: false,
		nativeUsage: null,
		nativeCycles: 0,
	} as Job;
}

/** The level that the argv asks for, or null when it asks for none. */
function levelOf(args: string[]): string | null {
	const at = args.indexOf("--thinking");
	return at === -1 ? null : (args[at + 1] ?? null);
}

test("a job with a thinking level asks OMP for that level", () => {
	const args = ompArgv(jobWith("low"), null);
	assert.equal(levelOf(args), "low");
});

test("a job without a thinking level asks OMP for no level", () => {
	const args = ompArgv(jobWith(null), null);
	assert.equal(levelOf(args), null);
});

test("a resumed job keeps the thinking level of the source run", () => {
	const args = ompArgv(jobWith("medium"), "/s/wz-1/a.jsonl");
	assert.equal(levelOf(args), "medium");
});
test("a restricted tool list includes the worker report tool", () => {
	const job = { ...jobWith(null), tools: ["read", "grep", "glob"] } as Job;
	const args = ompArgv(job, null);
	const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
	assert.ok(tools.includes("wezterm_worker_report"), "the report tool is missing");
});

test("a restricted tool list includes the worker channel tools", () => {
	const job = { ...jobWith(null), tools: ["read"] } as Job;
	const args = ompArgv(job, null);
	const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
	assert.ok(tools.includes("wezterm_worker_report"), "the report tool is missing");
	assert.ok(tools.includes("wezterm_worker_note_to_main"), "the note tool of the worker is missing");
	assert.ok(tools.includes("wezterm_worker_notes_from_main"), "the read tool of the worker is missing");
});

test("an existing report tool appears once in argv", () => {
	const job = { ...jobWith(null), tools: ["read", "wezterm_worker_report"] } as Job;
	const args = ompArgv(job, null);
	const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
	assert.equal(tools.filter((tool) => tool === "wezterm_worker_report").length, 1);
});

test("a null tool list has no tools flag", () => {
	assert.equal(ompArgv(jobWith(null), null).includes("--tools"), false);
});

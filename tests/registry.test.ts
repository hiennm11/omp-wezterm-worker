import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { loadRegistry, persistRegistry, registryFile } from "../extensions/lib/registry.ts";

/** Build a job with the fields a test needs. */
function job(overrides: Partial<Job> = {}): Job {
	return {
		id: "wz-test-1",
		label: "test",
		task: "do it",
		cwd: "/tmp/work",
		model: null,
		tools: null,
		status: "completed",
		paneId: 7,
		tabId: 0,
		windowId: 0,
		placement: "split",
		sessionDir: "/tmp/state/sessions/wz-test-1",
		sessionFile: null,
		createdAt: 1000,
		startedAt: 1100,
		finishedAt: 1200,
		result: "PONG",
		error: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		worktreeDirty: null,
		cancelled: false,
		lastActivityAt: 1150,
		currentTool: null,
		turns: 1,
		baselineTurns: 0,
		steers: 0,
		lastTranscriptSize: 100,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		paneClosed: true,
		...overrides,
	};
}

test("a written job comes back unchanged", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	const original = job();
	persistRegistry(dir, [original]);
	const { finished, alive } = loadRegistry(dir);
	assert.equal(alive.length, 0);
	assert.equal(finished.length, 1);
	assert.equal(finished[0].id, original.id);
	assert.equal(finished[0].result, "PONG");
	assert.equal(finished[0].paneId, 7);
	assert.equal(finished[0].worktreeDirty, null);
	rmSync(dir, { recursive: true, force: true });
});

test("a running job with a pane comes back as alive", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	persistRegistry(dir, [job({ id: "wz-live", status: "running", paneId: 3 })]);
	const { finished, alive } = loadRegistry(dir);
	assert.equal(finished.length, 0);
	assert.equal(alive.length, 1);
	assert.equal(alive[0].id, "wz-live");
	rmSync(dir, { recursive: true, force: true });
});

test("a running job without a pane comes back as finished", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	persistRegistry(dir, [job({ id: "wz-orphan", status: "running", paneId: null })]);
	const { finished, alive } = loadRegistry(dir);
	assert.equal(alive.length, 0);
	assert.equal(finished.length, 1);
	rmSync(dir, { recursive: true, force: true });
});

test("a missing registry yields nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	const { finished, alive } = loadRegistry(dir);
	assert.deepEqual(finished, []);
	assert.deepEqual(alive, []);
	rmSync(dir, { recursive: true, force: true });
});

test("a malformed registry yields nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	writeFileSync(registryFile(dir), "{not json", "utf8");
	const { finished, alive } = loadRegistry(dir);
	assert.deepEqual(finished, []);
	assert.deepEqual(alive, []);
	rmSync(dir, { recursive: true, force: true });
});

test("a job of the wrong shape does not break the load", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	writeFileSync(
		registryFile(dir),
		JSON.stringify({
			version: 1,
			jobs: [
				{ id: "wz-ok", status: "completed", result: "fine" },
				{ noId: true },
				null,
				{ id: "wz-bad-status", status: "exploded" },
				{ id: "wz-bad-types", paneId: "seven", turns: "many", tools: "read" },
			],
		}),
		"utf8",
	);
	const { finished, alive } = loadRegistry(dir);
	assert.equal(alive.length, 0);
	assert.equal(finished.length, 3);
	const bad = finished.find((j) => j.id === "wz-bad-status");
	assert.equal(bad?.status, "completed");
	const types = finished.find((j) => j.id === "wz-bad-types");
	assert.equal(types?.paneId, null);
	assert.equal(types?.turns, 0);
	assert.equal(types?.tools, null);
	rmSync(dir, { recursive: true, force: true });
});

test("the write is atomic and leaves no temp file", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-registry-"));
	persistRegistry(dir, [job()]);
	const payload = JSON.parse(readFileSync(registryFile(dir), "utf8")) as { version: number };
	assert.equal(payload.version, 1);
	rmSync(dir, { recursive: true, force: true });
});

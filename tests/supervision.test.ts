import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, type Ownership } from "../extensions/lib/ownership.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { supervisionLine } from "../extensions/lib/supervision.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { toolOf } from "./codex-events-helpers.ts";

const job: Job = {
	id: "wz-test",
	label: "test",
	task: "test",
	cwd: "/repo",
	model: null,
	tools: null,
	placement: "split",
	sessionDir: "/sessions/wz-test",
	sessionFile: null,
	worktreePath: null,
	worktreeBranch: null,
	worktreeOrigin: null,
	timeoutMs: 0,
	idleTimeoutMs: 0,
	closePaneOnFinish: true,
	...freshRunState(1),
	status: "running",
	paneId: 7,
};

function owner(overrides: Partial<Ownership> = {}): Ownership {
	return {
		taskKey: "task-wz-test",
		sessionId: "session-a",
		processId: 10,
		processStartedAt: "start-a",
		generation: 1,
		phase: "active",
		updatedAt: 1,
		...overrides,
	};
}

test("the status tool tells that another process owns an active task", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wz-supervision-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = dir;
	try {
		rt.jobs.set(job.id, { ...job, sessionDir: join(dir, "session") });
		rt.sessionId = "session-b";
		acquireOwnership(rt.openDb(), taskKey(job.id), "session-a", 10, "start-a", 1);
		const status = toolOf(rt, registerStatusTool, "status");
		const result = await status.execute("t1", { workerId: job.id });
		const text = result.content[0]?.text ?? "";
		assert.match(text, /supervision: read-only here: session session-a, process 10/);
		assert.match(JSON.stringify(result.details), /read-only here: session session-a, process 10/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the status tool names the lease answer of a read-only task", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wz-supervision-lease-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = dir;
	try {
		rt.jobs.set(job.id, { ...job, sessionDir: join(dir, "session") });
		rt.sessionId = "session-b";
		rt.sessionLeaseHeld = async () => true;
		acquireOwnership(rt.openDb(), taskKey(job.id), "session-a", 10, "start-a", 1);
		const status = toolOf(rt, registerStatusTool, "status");
		const result = await status.execute("t1", { workerId: job.id });
		const text = result.content[0]?.text ?? "";
		assert.match(text, /lease of the session is true/);
		assert.match(text, /owner process is 10/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an owned active task without a monitor reports not supervised", () => {
	assert.equal(
		supervisionLine(job, owner(), "session-a", 10, "start-a", false),
		"NOT SUPERVISED: this process owns the task, but no monitor watches it.",
	);
});

test("an active task owned elsewhere reports read-only status", () => {
	const line = supervisionLine(job, owner(), "session-b", 20, "start-b", false);
	assert.match(line ?? "", /^read-only here:/);
	assert.match(line ?? "", /session-a/);
	assert.match(line ?? "", /10/);
	assert.match(line ?? "", /alive or gone/);
	assert.match(line ?? "", /close|restart OMP/);
});

test("a read-only row names the lease answer and the process id", () => {
	const held = supervisionLine(job, owner(), "session-b", 20, "start-b", false, true);
	assert.match(held ?? "", /^read-only here:/);
	assert.match(held ?? "", /lease of the session is true/);
	assert.match(held ?? "", /owner process is 10/);

	const free = supervisionLine(job, owner(), "session-b", 20, "start-b", false, false);
	assert.match(free ?? "", /^read-only here:/);
	assert.match(free ?? "", /lease of the session is false/);
	assert.match(free ?? "", /owner process is 10/);

	const unknown = supervisionLine(job, owner(), "session-b", 20, "start-b", false, null);
	assert.match(unknown ?? "", /^read-only here:/);
	assert.match(unknown ?? "", /lease of the session is null/);
	assert.match(unknown ?? "", /owner process is 10/);
});

test("a monitored active task has no supervision warning", () => {
	assert.equal(supervisionLine(job, owner(), "session-a", 10, "start-a", true), null);
});

test("finished jobs and missing ownership have no supervision line", () => {
	assert.equal(
		supervisionLine({ ...job, status: "completed" }, owner(), "session-a", 10, "start-a", false),
		null,
	);
	assert.equal(supervisionLine(job, null, "session-a", 10, "start-a", false), null);
});

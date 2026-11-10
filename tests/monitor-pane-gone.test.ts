import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

function setup(
	stateDir: string,
	listCode = 0,
): { rt: WorkerRuntime; ticks: (() => void)[]; paneReads: () => number } {
	let paneReads = 0;
	const rt = createRuntime(async (_bin, args) => {
		if (args[0] === "pane" && args[1] === "list") {
			paneReads += 1;
			const listing = { result: { panes: [] } };
			return { code: listCode, stdout: listCode === 0 ? JSON.stringify(listing) : "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	});
	rt.config.stateDir = stateDir;
	const ticks: (() => void)[] = [];
	rt.timers = {
		setInterval: (fn) => {
			ticks.push(fn);
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, ticks, paneReads: () => paneReads };
}

function activeJob(sessionDir: string): Job {
	return {
		id: "wz-pane-gone",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: "w1:p7",
	};
}

async function settleActions(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

function transcript(sessionDir: string): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, "session.jsonl"),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } }),
	);
}

test("a transcript worker with a gone pane leaves the active set on a tick", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-pane-gone-"));
	const { rt, ticks } = setup(stateDir);
	const sessionDir = join(stateDir, "sessions", "wz-pane-gone");
	transcript(sessionDir);
	const job = activeJob(sessionDir);
	rt.jobs.set(job.id, job);
	try {
		monitorJob(rt, job, () => undefined);
		ticks[0]();
		await settleActions();
		assert.notEqual(job.status, "running", "the gone pane must not hold an active worker slot");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("an unreadable pane list does not settle the worker", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-pane-gone-"));
	const { rt, ticks, paneReads } = setup(stateDir, 1);
	const sessionDir = join(stateDir, "sessions", "wz-pane-gone");
	transcript(sessionDir);
	const job = activeJob(sessionDir);
	rt.jobs.set(job.id, job);
	try {
		monitorJob(rt, job, () => undefined);
		ticks[0]();
		await settleActions();
		assert.equal(job.status, "running");
		assert.ok(paneReads() > 0, "the tick must read the pane list");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a finished worker is not read or changed by the pane check", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-pane-gone-"));
	const { rt, ticks, paneReads } = setup(stateDir);
	const sessionDir = join(stateDir, "sessions", "wz-pane-gone");
	transcript(sessionDir);
	const job = activeJob(sessionDir);
	job.status = "completed";
	job.result = "done";
	rt.jobs.set(job.id, job);
	try {
		monitorJob(rt, job, () => undefined);
		ticks[0]();
		await settleActions();
		assert.equal(job.status, "completed");
		assert.equal(job.error, null);
		assert.equal(paneReads(), 0);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

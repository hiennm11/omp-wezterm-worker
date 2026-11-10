/**
 * The pane of the source run of a resume.
 *
 * A resume starts a second writer for the transcript of its source run. The
 * pane of the source run must be gone before the resume starts. A pane that
 * is still open refuses the resume. A pane list that cannot be read refuses
 * the resume too.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup, readGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import type * as ResumeGuard from "../extensions/lib/resume-guard.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";

/** The reason that the Claude tests do not run. */
const CLAUDE_ON_HERDR = "The Claude Code backend does not run on Herdr yet. Issue 159 brings it back.";

/** The reason that a resume refuses a source run whose pane is still open. */
const PRESENT_REFUSAL =
	"The pane w1:p42 of the source run is still open. Close pane w1:p42, then resume again.";

/** The reason that a resume refuses a source run whose pane list cannot be read. */
const UNKNOWN_REFUSAL =
	"The pane list cannot be read, so the state of pane w1:p42 is unknown. Try the resume again.";

/**
 * The guard module.
 *
 * A static import cannot work here. The module does not exist yet, and a
 * missing module stops the whole file from loading. The other tests must run
 * and fail on their own behaviour.
 */
async function loadGuard(): Promise<typeof ResumeGuard> {
	return await import("../extensions/lib/resume-guard.ts");
}

/** A runtime with a database in a fresh directory. */
function freshRuntime(exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-resume-pane-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** A session directory with a transcript in it. */
function sessionDirOf(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return sessionDir;
}

/** The source run of a resume. */
function sourceJob(id: string, sessionDir: string, overrides: Partial<Job> = {}): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "completed",
		paneId: "w1:p42",
		runtime: "herdr",
		...overrides,
	};
}

/**
 * The fake WezTerm of these tests.
 *
 * The pane list answers with the given panes. The launch answers with the
 * given result. The calls are recorded, so a test can see what ran.
 */
function fakeWezterm(options: {
	panes: unknown;
	listCode?: number;
	launch?: { code: number; stdout: string; stderr: string };
}): { exec: RunFn; calls: string[][] } {
	const calls: string[][] = [];
	const launch = options.launch ?? {
		code: 0,
		stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p99", tab_id: "w1:t1" } } }),
		stderr: "",
	};
	const exec: RunFn = async (bin, args) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "list") {
			const code = options.listCode ?? 0;
			return { code, stdout: code === 0 ? JSON.stringify(options.panes) : "", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "split") return launch;
		if (args[0] === "pane" && args[1] === "read") {
			return { code: 0, stdout: "bypass permissions on", stderr: "" };
		}
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

/** True when a call started a pane. */
function launchedPane(calls: string[][]): boolean {
	return calls.some((args) => args[0] === "pane" && args[1] === "split");
}

test("a resume refuses a source run whose pane is still open", async () => {
	const { exec, calls } = fakeWezterm({
		panes: { result: { panes: [{ pane_id: "w1:p42", tab_id: "w1:t1" }] } },
	});
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-source-1");
		const source = sourceJob("wz-source-1", sessionDir);
		createGroup(db, "grp-wz-source-1", sessionDir, 1000);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-1" });

		assert.equal(resumed.status, "failed");
		assert.equal(resumed.error, PRESENT_REFUSAL);
		assert.notEqual(resumed.finishedAt, null);
		assert.equal(rt.jobs.get("wz-resume-1")?.status, "failed");
		const group = readGroup(db, "grp-wz-source-1");
		assert.equal(group?.executionState, "free");
		assert.equal(group?.executionHolder, null);
		assert.equal(launchedPane(calls), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume refuses a source run when the pane list cannot be read", async () => {
	const { exec, calls } = fakeWezterm({ panes: { result: { panes: [] } }, listCode: 1 });
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-source-2");
		const source = sourceJob("wz-source-2", sessionDir);
		createGroup(db, "grp-wz-source-2", sessionDir, 1000);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-2" });

		assert.equal(resumed.status, "failed");
		assert.equal(resumed.error, UNKNOWN_REFUSAL);
		assert.notEqual(resumed.finishedAt, null);
		const group = readGroup(db, "grp-wz-source-2");
		assert.equal(group?.executionState, "free");
		assert.equal(group?.executionHolder, null);
		assert.equal(launchedPane(calls), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume goes on when the pane of the source run is gone", async () => {
	const { exec } = fakeWezterm({
		panes: { result: { panes: [] } },
		launch: { code: 1, stdout: "", stderr: "the split failed" },
	});
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-source-3");
		const source = sourceJob("wz-source-3", sessionDir);
		createGroup(db, "grp-wz-source-3", sessionDir, 1000);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-3" });

		assert.equal(resumed.status, "failed");
		assert.notEqual(resumed.error, PRESENT_REFUSAL);
		assert.notEqual(resumed.error, UNKNOWN_REFUSAL);
		assert.match(resumed.error ?? "", /split failed/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume of a source run without a pane does not read the pane list", async () => {
	const { exec, calls } = fakeWezterm({
		panes: { result: { panes: [] } },
		launch: { code: 1, stdout: "", stderr: "the split failed" },
	});
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-source-4");
		const source = sourceJob("wz-source-4", sessionDir, { paneId: null });
		createGroup(db, "grp-wz-source-4", sessionDir, 1000);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-4" });

		assert.equal(resumed.status, "failed");
		assert.match(resumed.error ?? "", /split failed/);
		assert.equal(
			calls.some((args) => args[0] === "pane" && args[1] === "list"),
			false,
		);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume refuses a completed source run whose pane is still open", async () => {
	const { exec, calls } = fakeWezterm({
		panes: { result: { panes: [{ pane_id: "w1:p42", tab_id: "w1:t1" }] } },
	});
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-source-5");
		const source = sourceJob("wz-source-5", sessionDir, {
			status: "completed",
			closePaneOnFinish: false,
			paneId: "w1:p42",
			runtime: "herdr",
		});
		createGroup(db, "grp-wz-source-5", sessionDir, 1000);

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-5" });

		assert.equal(resumed.status, "failed");
		assert.equal(resumed.error, PRESENT_REFUSAL);
		const group = readGroup(db, "grp-wz-source-5");
		assert.equal(group?.executionState, "free");
		assert.equal(launchedPane(calls), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a native resume refuses a source run whose pane is still open", { skip: CLAUDE_ON_HERDR }, async () => {
	const { exec, calls } = fakeWezterm({
		panes: { result: { panes: [{ pane_id: "w1:p42", tab_id: "w1:t1" }] } },
	});
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-source-6");
		const source = sourceJob("wz-source-6", sessionDir, {
			backend: "claude",
			nativeSessionId: "sess-1",
		});
		createGroup(db, "grp-wz-source-6", sessionDir, 1000);

		const resumed = await resumeClaudeWorker(rt, {
			jobId: "wz-resume-6",
			source,
			sessionId: "sess-1",
		});

		assert.equal(resumed.status, "failed");
		assert.equal(resumed.error, PRESENT_REFUSAL);
		assert.notEqual(resumed.finishedAt, null);
		assert.equal(rt.bridges.size, 0);
		assert.equal(launchedPane(calls), false);
		const group = readGroup(db, "grp-wz-source-6");
		assert.equal(group?.executionState, "free");
		assert.equal(group?.executionHolder, null);
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the refusal of a source pane names the pane and asks for its close", async () => {
	const { sourcePaneRefusal } = await loadGuard();
	assert.equal(sourcePaneRefusal("present", "w1:p42"), PRESENT_REFUSAL);
});

test("the refusal of an unreadable pane list asks for a retry", async () => {
	const { sourcePaneRefusal } = await loadGuard();
	assert.equal(sourcePaneRefusal("unknown", "w1:p42"), UNKNOWN_REFUSAL);
});

test("a gone pane refuses no resume", async () => {
	const { sourcePaneRefusal } = await loadGuard();
	assert.equal(sourcePaneRefusal("gone", "w1:p42"), null);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup, readGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";

/** The reason that the Claude tests do not run. */
const CLAUDE_ON_HERDR = "The Claude Code backend does not run on Herdr yet. Issue 159 brings it back.";

const FAIL_TEXT = "json: Invalid JSON syntax: Unexpected EOF";

function setup(exec: RunFn) {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-validate-"));
	/* The extension refuses a spawn outside a Herdr session. */
	process.env.HERDR_ENV = "1";
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.claudeBin = "claude";
	return { rt, dir };
}

function job(id: string, sessionDir: string): Job {
	mkdirSync(sessionDir, { recursive: true });
	const transcript = join(sessionDir, "a.jsonl");
	writeFileSync(transcript, "", "utf8");
	return {
		id,
		label: id,
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: transcript,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "completed",
		paneId: null,
		backend: "claude",
		nativeSessionId: "sess-1",
	};
}

test("spawn refuses an invalid plugin before bridge, group, attempt, or pane creation", {
	skip: CLAUDE_ON_HERDR,
}, async () => {
	const calls: { bin: string; args: string[] }[] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push({ bin, args });
		if (args[0] === "plugin") return { code: 1, stdout: FAIL_TEXT, stderr: "" };
		if (args.includes("--version")) return { code: 0, stdout: "Claude", stderr: "" };
		if (args[0] === "pane" && args[1] === "list")
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		if ((args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"))
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p88", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		return { code: 0, stdout: "", stderr: "" };
	};
	const { rt, dir } = setup(exec);
	try {
		const result = await spawnClaudeWorker(rt, {
			jobId: "wz-invalid",
			task: "task",
			cwd: dir,
			sessionId: "sess-1",
		});
		assert.equal(result.status, "failed");
		assert.match(
			result.error ?? "",
			/The installed Claude Code refused the mod of the extension:.*Invalid JSON syntax/,
		);
		assert.equal(rt.bridges.size, 0);
		assert.equal(calls.filter(({ args }) => args[0] === "plugin").length, 1);
		assert.ok(
			calls.some(({ args }) => args[0] === "plugin" && args[2] === join(result.sessionDir, "claude-plugin")),
		);
		assert.equal(
			calls.some(
				({ args }) =>
					(args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"),
			),
			false,
		);
		const db = rt.openDb();
		assert.equal(
			(
				db.handle.prepare("SELECT COUNT(*) AS n FROM launch_attempts WHERE job_id = ?").get(result.id) as {
					n: number;
				}
			).n,
			0,
		);
		assert.equal(
			(
				db.handle
					.prepare("SELECT COUNT(*) AS n FROM resource_groups WHERE id = ?")
					.get(`grp-${result.id}`) as { n: number }
			).n,
			0,
		);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resume accepts a validated plugin and launches the worker", { skip: CLAUDE_ON_HERDR }, async () => {
	const calls: { bin: string; args: string[] }[] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push({ bin, args });
		if (args[0] === "plugin") return { code: 0, stdout: "Found 1 warning", stderr: "" };
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		if (args[0] === "pane" && args[1] === "list")
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		if (args.includes("--version")) return { code: 0, stdout: "Claude", stderr: "" };
		if (args[0] === "pane" && args[1] === "read")
			return { code: 0, stdout: "bypass permissions on", stderr: "" };
		if ((args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"))
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p88", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		return { code: 0, stdout: "", stderr: "" };
	};
	const { rt, dir } = setup(exec);
	try {
		const sessionDir = join(dir, "sessions", "wz-source");
		const source = job("wz-source", sessionDir);
		createGroup(rt.openDb(), "grp-wz-source", sessionDir, 1);
		const result = await resumeClaudeWorker(rt, { jobId: "wz-resume-ok", source, sessionId: "" });
		assert.equal(result.status, "running", result.error ?? "missing resume error");
		assert.ok(
			calls.some(({ args }) => args[0] === "plugin" && args[2] === join(sessionDir, "claude-plugin")),
		);
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawn accepts validation warnings and launches the worker", { skip: CLAUDE_ON_HERDR }, async () => {
	const calls: { bin: string; args: string[] }[] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push({ bin, args });
		if (args[0] === "plugin") return { code: 0, stdout: "Found 1 warning", stderr: "" };
		if (args.includes("--version")) return { code: 0, stdout: "Claude", stderr: "" };
		if (args[0] === "pane" && args[1] === "list")
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		if ((args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"))
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p88", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		return { code: 0, stdout: "", stderr: "" };
	};
	const { rt, dir } = setup(exec);
	try {
		const result = await spawnClaudeWorker(rt, {
			jobId: "wz-warning",
			task: "task",
			cwd: dir,
			sessionId: "sess-1",
		});
		assert.equal(result.status, "running");
		assert.ok(calls.some(({ args }) => args[0] === "plugin"));
		assert.equal(rt.bridges.size, 1);
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawn reports a validation execution error and does not launch", {
	skip: CLAUDE_ON_HERDR,
}, async () => {
	const calls: { bin: string; args: string[] }[] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push({ bin, args });
		if (args[0] === "plugin") throw new Error("cannot execute Claude");
		if (args.includes("--version")) return { code: 0, stdout: "Claude", stderr: "" };
		if (args[0] === "pane" && args[1] === "list")
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const { rt, dir } = setup(exec);
	try {
		const result = await spawnClaudeWorker(rt, {
			jobId: "wz-throws",
			task: "task",
			cwd: dir,
			sessionId: "sess-1",
		});
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /The mod of the extension could not be checked:.*cannot execute Claude/);
		assert.equal(
			calls.some(
				({ args }) =>
					(args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"),
			),
			false,
		);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resume refuses an invalid plugin and releases the resource group", {
	skip: CLAUDE_ON_HERDR,
}, async () => {
	const calls: { bin: string; args: string[] }[] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push({ bin, args });
		if (args[0] === "plugin") return { code: 1, stdout: FAIL_TEXT, stderr: "" };
		if (args[0] === "pane" && args[1] === "list")
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		if (args.includes("--version")) return { code: 0, stdout: "Claude", stderr: "" };
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		if ((args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"))
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p88", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		return { code: 0, stdout: "", stderr: "" };
	};
	const { rt, dir } = setup(exec);
	try {
		const sessionDir = join(dir, "sessions", "wz-source");
		const source = job("wz-source", sessionDir);
		const db = rt.openDb();
		createGroup(db, "grp-wz-source", sessionDir, 1);
		const result = await resumeClaudeWorker(rt, { jobId: "wz-resume", source, sessionId: "sess-1" });
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /The installed Claude Code refused the mod of the extension:/);
		assert.equal(rt.bridges.size, 0);
		assert.equal(
			calls.some(
				({ args }) =>
					(args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"),
			),
			false,
		);
		assert.equal(readGroup(db, "grp-wz-source")?.executionState, "free");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

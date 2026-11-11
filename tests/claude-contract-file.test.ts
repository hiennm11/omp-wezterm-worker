/**
 * The contract file of a Claude Code worker.
 *
 * The reporting contract has many lines. Herdr refuses an argument with a
 * line break, so the contract travels in a file and the launch passes the
 * path. The file holds the contract at the moment of the launch.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { REPORTING_CONTRACT, writeClaudeContract } from "../extensions/lib/bootstrap-prompt.ts";
import { createGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";

/** One launch of a Claude worker, with the contract that it found. */
interface Launch {
	/** The argv of the program that Herdr started. */
	args: string[];
	/** The text of the contract file at the moment of the launch. */
	contract: string | null;
}

/**
 * A runtime that answers Herdr and records every launch.
 *
 * The launch reads the contract file, so a test sees the contract at the
 * moment that the program starts.
 */
function herdrRuntime(dir: string): { rt: WorkerRuntime; launches: Launch[] } {
	const launches: Launch[] = [];
	const exec: RunFn = async (_bin, args): Promise<RunResult> => {
		if (args[0] === "pane" && args[1] === "list") {
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		}
		if ((args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create")) {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p88", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		}
		if (args[0] === "agent" && args[1] === "start") {
			launches.push({ args, contract: contractAt(args) });
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "read") {
			return { code: 0, stdout: "bypass permissions on", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.claudeBin = "claude";
	rt.paneRuntime = "herdr";
	return { rt, launches };
}

/** The text of the contract file of an argv, or null when the argv names none. */
function contractAt(args: string[]): string | null {
	const at = args.indexOf("--append-system-prompt-file");
	if (at === -1) return null;
	const file = args[at + 1];
	return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** The path of the contract file of an argv, or null when the argv names none. */
function contractPathOf(args: string[]): string | null {
	const at = args.indexOf("--append-system-prompt-file");
	return at === -1 ? null : (args[at + 1] ?? null);
}

/** A source run that a resume acts on. */
function sourceJob(dir: string, id: string): Job {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	return {
		id,
		label: "claude source",
		task: "Reply with the single word OK.",
		cwd: dir,
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
		backend: "claude",
		nativeSessionId: "sess-1",
		...freshRunState(Date.now()),
		status: "completed",
	};
}

test("the contract file holds the reporting contract", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-contract-"));
	try {
		const file = writeClaudeContract(dir);
		assert.equal(file, join(dir, ".claude-contract.md"));
		assert.equal(readFileSync(file, "utf8"), REPORTING_CONTRACT);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the contract file holds the same bytes for every run", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-contract-"));
	try {
		const first = writeClaudeContract(dir);
		const second = writeClaudeContract(dir);
		assert.equal(first, second);
		assert.equal(readFileSync(second, "utf8"), readFileSync(first, "utf8"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude spawn on Herdr gives the program the path of the contract", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-contract-"));
	const { rt, launches } = herdrRuntime(dir);
	try {
		const job = await spawnClaudeWorker(rt, {
			jobId: "wz-claude-contract",
			task: "Reply with the single word OK.",
			cwd: dir,
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		assert.equal(job.status, "running", job.error ?? "the spawn failed");
		assert.equal(launches.length, 1, "the program started once");
		const args = launches[0].args;
		assert.equal(args.includes("--append-system-prompt"), false, "the contract is not inline");
		const file = contractPathOf(args);
		assert.ok(file, "the argv names no contract file");
		assert.equal(file, join(job.sessionDir, ".claude-contract.md"));
		assert.equal(launches[0].contract, REPORTING_CONTRACT);
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude resume writes its own contract file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-contract-"));
	const { rt, launches } = herdrRuntime(dir);
	try {
		const source = sourceJob(dir, "wz-claude-source");
		createGroup(rt.openDb(), "grp-wz-claude-source", source.sessionDir, Date.now());
		const job = await resumeClaudeWorker(rt, {
			jobId: "wz-claude-resume",
			source,
			sessionId: "",
		});
		assert.equal(job.status, "running", job.error ?? "the resume failed");
		assert.equal(launches.length, 1, "the program started once");
		const file = contractPathOf(launches[0].args);
		assert.ok(file, "the argv names no contract file");
		assert.equal(file, join(source.sessionDir, ".claude-contract.md"));
		assert.equal(existsSync(file), true);
		assert.equal(launches[0].contract, REPORTING_CONTRACT);
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

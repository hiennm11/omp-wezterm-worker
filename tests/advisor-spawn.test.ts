/**
 * The advisor of a spawn.
 *
 * The spawn tool accepts the parameter `advisor`. A Claude Code worker
 * refuses the parameter. A preset can turn the advisor on, and a call
 * parameter wins over the preset.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { deliveryTracker } from "./delivery-helpers.ts";

/** The context of a call of the spawn tool. */
const CONTEXT = {
	cwd: process.cwd(),
	sessionManager: { getSessionFile: () => null, getSessionId: () => null },
};

/** The spawn tool of a fake runtime. */
function spawnToolOf(fake: { rt: WorkerRuntime }): {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
} {
	const tools = new Map<
		string,
		{
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal?: unknown,
				onUpdate?: unknown,
				ctx?: unknown,
			) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
		}
	>();
	const chain = { optional: () => chain, describe: () => chain };
	registerSpawnTool({
		pi: {
			zod: {
				string: () => chain,
				number: () => chain,
				boolean: () => chain,
				array: () => chain,
				object: () => chain,
			},
			registerTool: (tool: { name: string; execute: unknown }) => tools.set(tool.name, tool as never),
		} as never,
		rt: fake.rt,
		deliver: () => undefined,
	});
	const tool = tools.get("wezterm_spawn_worker");
	assert.ok(tool, "the spawn tool was not registered");
	return tool;
}

/** The argv of the OMP program of a launch, or null when no OMP program started. */
function ompArgvOf(calls: string[][]): string[] | null {
	for (const call of calls) {
		const at = call.indexOf("omp");
		if (at !== -1) return call.slice(at + 1);
	}
	return null;
}

/** A runtime that answers the version check, the pane list and the launch. */
function ompRuntime(): { rt: WorkerRuntime; dir: string; calls: string[][] } {
	const dir = mkdtempSync(join(tmpdir(), "wt-advisor-"));
	const calls: string[][] = [];
	const tracker = deliveryTracker();
	const exec: RunFn = async (bin, args) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "list") {
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "split") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p99", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		}
		if (args[0] === "tab" && args[1] === "create") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p99", tab_id: "w1:t2" } } }),
				stderr: "",
			};
		}
		if (args[0] === "agent" && args[1] === "start") {
			tracker.onStart(args);
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (args[0] === "agent" && args[1] === "prompt") {
			tracker.onPrompt();
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir, calls };
}

/** The job of a source run of a resume. */
function sourceJob(id: string, sessionDir: string, advisor: boolean): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		advisor,
		placement: "split",
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: false,
		...freshRunState(0),
		status: "completed",
		paneId: null,
	} as Job;
}

test("a spawn with the advisor asks OMP for the advisor", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, advisor: true },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const argv = ompArgvOf(calls);
		assert.ok(argv, "no OMP program started");
		assert.equal(argv.includes("--advisor"), true, argv.join(" "));
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn without the advisor asks OMP for nothing", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const argv = ompArgvOf(calls);
		assert.ok(argv, "no OMP program started");
		assert.equal(argv.includes("--advisor"), false, argv.join(" "));
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn with the advisor and the Claude backend is refused before the launch", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, backend: "claude", advisor: true },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Claude Code/);
		assert.deepEqual(calls, []);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the reply of a spawn names the advisor only when it is on", async () => {
	const { rt, dir } = ompRuntime();
	try {
		const tool = spawnToolOf({ rt });
		const on = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, advisor: true },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(on.isError, true, on.content[0]?.text);
		assert.match(on.content[0]?.text ?? "", /advisor: on/);
		const off = await tool.execute(
			"t2",
			{ task: "Read baseline.txt.", cwd: dir },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(off.isError, true, off.content[0]?.text);
		assert.equal(/advisor: on/.test(off.content[0]?.text ?? ""), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a preset with the advisor turns the advisor on", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		rt.config.presets = { advised: { advisor: true } };
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, preset: "advised" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const argv = ompArgvOf(calls);
		assert.ok(argv, "no OMP program started");
		assert.equal(argv.includes("--advisor"), true, argv.join(" "));
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a call that turns the advisor off wins over the preset", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		rt.config.presets = { advised: { advisor: true } };
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, preset: "advised", advisor: false },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const argv = ompArgvOf(calls);
		assert.ok(argv, "no OMP program started");
		assert.equal(argv.includes("--advisor"), false, argv.join(" "));
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume keeps the advisor of the source run", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		const db = rt.openDb();
		const sessionDir = join(dir, "sessions", "wz-source-1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
		createGroup(db, "grp-wz-source-1", sessionDir, 1000);
		const source = sourceJob("wz-source-1", sessionDir, true);

		await resumeWorker(rt, source, { jobId: "wz-resume-1" });

		const argv = calls.find((args) => args[0] === "agent" && args[1] === "start");
		assert.ok(argv, "no pane started");
		assert.equal(argv.includes("--advisor"), true, argv.join(" "));
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

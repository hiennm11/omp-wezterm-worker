/**
 * The thinking level of a spawn.
 *
 * The spawn tool accepts the parameter `thinking`. An unknown level is
 * refused before the plugin opens a pane. A native backend refuses the
 * parameter. A spawn parameter wins over the config file.
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
import { resumeWorker, spawnWorker } from "../extensions/lib/spawn.ts";
import type { ThinkingLevel } from "../extensions/lib/thinking.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { codexFake } from "./codex-spawn-helpers.ts";

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
function ompRuntime(options: { thinking?: string | null } = {}): {
	rt: WorkerRuntime;
	dir: string;
	calls: string[][];
} {
	const dir = mkdtempSync(join(tmpdir(), "wt-thinking-"));
	const calls: string[][] = [];
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
		if (args[0] === "agent" && args[1] === "start") {
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	if (options.thinking !== undefined) rt.config.thinking = options.thinking as ThinkingLevel | null;
	return { rt, dir, calls };
}

/** The job of a source run of a resume. */
function sourceJob(id: string, sessionDir: string, thinking: string | null): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		thinking,
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

test("a spawn with an unknown thinking level is refused before the launch", async () => {
	const fake = codexFake();
	try {
		const tool = spawnToolOf(fake);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: fake.dir, thinking: "loud" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /thinking/i);
		assert.deepEqual(fake.programs, []);
		assert.equal(fake.panes.size, 0);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("a spawn with a thinking level and the Claude backend is refused before the launch", async () => {
	const fake = codexFake();
	try {
		const tool = spawnToolOf(fake);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: fake.dir, backend: "claude", thinking: "low" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Claude Code/);
		assert.deepEqual(fake.programs, []);
		assert.equal(fake.panes.size, 0);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("a spawn with a thinking level and the Codex backend is refused before the launch", async () => {
	const fake = codexFake();
	try {
		const tool = spawnToolOf(fake);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: fake.dir, backend: "codex", thinking: "low" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Codex/);
		assert.deepEqual(fake.programs, []);
		assert.equal(fake.panes.size, 0);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("a spawn with a thinking level asks OMP for that level", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, thinking: "low" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const argv = ompArgvOf(calls);
		assert.ok(argv, "no OMP program started");
		const at = argv.indexOf("--thinking");
		assert.notEqual(at, -1, argv.join(" "));
		assert.equal(argv[at + 1], "low");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the reply of a spawn names the requested thinking level", async () => {
	const { rt, dir } = ompRuntime();
	try {
		const tool = spawnToolOf({ rt });
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, thinking: "medium" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		assert.match(result.content[0]?.text ?? "", /medium/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn parameter wins over the thinking level of the config", async () => {
	const { rt, dir, calls } = ompRuntime({ thinking: "high" });
	try {
		await spawnWorker(rt, {
			jobId: "wz-think-1",
			task: "Read baseline.txt.",
			cwd: dir,
			thinking: "low",
		});
		const job = rt.jobs.get("wz-think-1");
		assert.equal(job?.thinking, "low");
		const argv = calls.find((args) => args[0] === "agent" && args[1] === "start");
		assert.ok(argv, "no pane started");
		const at = argv.indexOf("--thinking");
		assert.notEqual(at, -1, argv.join(" "));
		assert.equal(argv[at + 1], "low");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn without a thinking level takes the level of the config", async () => {
	const { rt, dir } = ompRuntime({ thinking: "high" });
	try {
		await spawnWorker(rt, {
			jobId: "wz-think-2",
			task: "Read baseline.txt.",
			cwd: dir,
		});
		assert.equal(rt.jobs.get("wz-think-2")?.thinking, "high");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume keeps the thinking level of the source run", async () => {
	const { rt, dir, calls } = ompRuntime();
	try {
		const db = rt.openDb();
		const sessionDir = join(dir, "sessions", "wz-source-1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
		createGroup(db, "grp-wz-source-1", sessionDir, 1000);
		const source = sourceJob("wz-source-1", sessionDir, "low");

		await resumeWorker(rt, source, { jobId: "wz-resume-1" });

		const argv = calls.find((args) => args[0] === "agent" && args[1] === "start");
		assert.ok(argv, "no pane started");
		const at = argv.indexOf("--thinking");
		assert.notEqual(at, -1, argv.join(" "));
		assert.equal(argv[at + 1], "low");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

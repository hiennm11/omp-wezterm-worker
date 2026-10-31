/**
 * The spawn with a backend.
 *
 * The OMP backend and the Claude Code backend keep their behaviour. The
 * Codex backend starts an app server and a TUI. The tests use the fake
 * runtime of a Codex spawn, so no test needs a real app server.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { type CodexFake, codexFake } from "./codex-spawn-helpers.ts";
import { createHost, sessionContext } from "./harness.ts";

/**
 * The job that a native spawn builds.
 *
 * The spawn runs the real function. The fake runtime answers the version
 * check and refuses the launch, so the job holds the parameters of the
 * spawn.
 */
async function nativeJob(params: { timeoutMs?: number; closePaneOnFinish?: boolean }): Promise<Job> {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-native-job-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	rt.config.claudeBin = "claude";
	try {
		return await spawnClaudeWorker(rt, {
			jobId: "wz-native-1",
			task: "task",
			cwd: stateDir,
			sessionId: "11111111-2222-3333-4444-555555555555",
			timeoutMs: params.timeoutMs,
			closePaneOnFinish: params.closePaneOnFinish,
		});
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
}

/** Build a host with a temporary state directory. */
async function makeHost(): Promise<{
	host: ReturnType<typeof createHost>;
	cwd: string;
}> {
	const cwd = mkdtempSync(join(tmpdir(), "wt-backend-"));
	const host = createHost({ cwd });
	await host.fire("session_start", sessionContext(cwd));
	return { host, cwd };
}

/**
 * The spawn tool of a fake runtime.
 *
 * The runtime answers the version check, the pane list and the process
 * table of Codex. The test calls the registered tool the way the agent
 * calls it.
 */
function spawnToolOf(fake: CodexFake): {
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

/** The context of a call of the spawn tool. */
const CONTEXT = {
	cwd: process.cwd(),
	sessionManager: { getSessionFile: () => null, getSessionId: () => null },
};

test("a spawn with an unknown backend is refused", async () => {
	const { host, cwd } = await makeHost();
	try {
		const result = await host.call("wezterm_spawn_worker", {
			task: "Read baseline.txt.",
			cwd,
			backend: "not-a-backend",
		});
		assert.match(host.text(result), /Unknown backend/);
	} finally {
		await host.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a spawn with a tool list and a native backend is refused before the launch", async () => {
	const { host, cwd } = await makeHost();
	try {
		const result = await host.call("wezterm_spawn_worker", {
			task: "Read baseline.txt.",
			cwd,
			backend: "claude",
			tools: ["read", "grep"],
		});
		assert.match(host.text(result), /OMP worker only/);
	} finally {
		await host.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a spawn with a tool list and the Codex backend is refused before the launch", async () => {
	const fake = codexFake();
	try {
		const tool = spawnToolOf(fake);

		const result = await tool.execute(
			"t1",
			{
				task: "Read baseline.txt.",
				cwd: fake.dir,
				backend: "codex",
				tools: ["read", "grep"],
			},
			undefined,
			undefined,
			CONTEXT,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /OMP worker only/);
		/* The refusal comes before the launch, so no pane exists. */
		assert.deepEqual(fake.programs, []);
		assert.equal(fake.panes.size, 0);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("a spawn with the Codex backend starts a Codex worker and no OMP worker", async () => {
	const fake = codexFake();
	try {
		const tool = spawnToolOf(fake);

		const result = await tool.execute(
			"t1",
			{
				task: "Reply with the single word OK.",
				cwd: fake.dir,
				backend: "codex",
			},
			undefined,
			undefined,
			CONTEXT,
		);

		assert.notEqual(result.isError, true, result.content[0]?.text);
		assert.equal(result.details.backend, "codex");
		assert.match(result.content[0]?.text ?? "", /backend: Codex/);
		/* The app server and the TUI are the two programs of the worker.
		   No OMP program started. */
		assert.equal(fake.programs.length, 2);
		assert.ok(
			fake.programs.every((program) => program.includes("codex")),
			fake.programs.join(", "),
		);
		const job = fake.rt.jobs.get(String(result.details.workerId));
		assert.ok(job, "the run of the worker is missing");
		assert.equal(job.backend, "codex");
		assert.equal(job.nativeSessionId, "thread-1");
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("a native worker takes the deadline and the pane policy of the spawn", async () => {
	/* A native worker that ignored the parameters would use the defaults of
	   the config. */
	const job = await nativeJob({ timeoutMs: 1234, closePaneOnFinish: false });
	assert.equal(job.timeoutMs, 1234);
	assert.equal(job.closePaneOnFinish, false);
});

test("a native worker without the parameters takes the defaults of the config", async () => {
	const job = await nativeJob({});
	assert.equal(job.timeoutMs, 30 * 60 * 1000);
	assert.equal(job.closePaneOnFinish, true);
});

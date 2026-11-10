/**
 * The spawn with a backend.
 *
 * The OMP backend and the Claude Code backend keep their behaviour. The
 * Codex backend was removed, so a spawn that names it is refused.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { createHost, sessionContext, type TestHost } from "./harness.ts";

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
async function makeHost(): Promise<{ host: TestHost; cwd: string }> {
	const cwd = mkdtempSync(join(tmpdir(), "wt-backend-"));
	const host = createHost({ cwd });
	await host.fire("session_start", sessionContext(cwd));
	return { host, cwd };
}

/** The context of a call of the spawn tool. */
const CONTEXT = {
	cwd: process.cwd(),
	sessionManager: { getSessionFile: () => null, getSessionId: () => null },
};

/**
 * The spawn tool of a runtime.
 *
 * The tool registers itself with the host. The test calls it the way the
 * agent calls it.
 */
function spawnToolOf(rt: WorkerRuntime): {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		update?: unknown,
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
				update?: unknown,
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
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("wezterm_spawn_worker");
	assert.ok(tool, "the spawn tool was not registered");
	return tool;
}

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

test("a spawn with the backend codex is refused and the reply lists the known backends", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-backend-codex-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = dir;
	rt.config.commsStandard = { mode: "off", minScore: 80 };
	try {
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, backend: "codex" },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /Unknown backend 'codex'/);
		assert.match(text, /omp/);
		assert.match(text, /claude/);
		assert.doesNotMatch(text, /codex,/, "the reply names codex as a known backend");
		/* The refusal comes before the launch, so no pane exists. */
		assert.equal(rt.jobs.size, 0);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
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

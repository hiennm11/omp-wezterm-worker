import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../extensions/lib/job.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";
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

test("a spawn with a backend that is not implemented is refused", async () => {
	const { host, cwd } = await makeHost();
	try {
		const result = await host.call("wezterm_spawn_worker", {
			task: "Read baseline.txt.",
			cwd,
			backend: "codex",
		});
		assert.match(host.text(result), /not implemented/);
		assert.match(host.text(result), /never falls back/);
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

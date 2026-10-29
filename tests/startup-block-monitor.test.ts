/**
 * The startup block of a native worker in the monitor.
 *
 * A Claude Code worker in a new repository waits at the trust dialog of
 * Claude Code. The session does not start while the dialog is open, so the
 * monitor raises an event and the person accepts the dialog in the pane.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyObservation, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { createEvent, eventsOfRun, pendingEvents } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";

const DIALOG =
	"Is this a project you created or one you trust?\n" + "1. No, exit\n" + "2. Yes, I trust this folder";

/** A runtime whose polls run only when the test calls them. */
function fakeRuntime(stateDir: string, paneText: string): { rt: WorkerRuntime; tick: () => void } {
	const rt = createRuntime(async (_bin, args) => {
		if (args.includes("get-text")) return { code: 0, stdout: paneText, stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	});
	rt.config.stateDir = stateDir;
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, tick: () => tick() };
}

/** A running native worker whose session started 61 seconds ago. */
function nativeJob(sessionDir: string): Job {
	const launchedAt = Date.now() - 61_000;
	return {
		id: "wz-1",
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
		...freshRunState(launchedAt),
		status: "running",
		paneId: 7,
		backend: "claude",
		startedAt: launchedAt,
	};
}

/**
 * Wait for the pane read of the monitor.
 *
 * The read of the pane is a promise. The test waits for the end of the
 * current turn of the event loop, so the promise of the read settles.
 */
async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

test("the native monitor raises one event for a worker that waits at the trust dialog", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-startup-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir, DIALOG);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, createClaudeRunState(job.id));

		monitorNativeJob(rt, job, () => undefined);
		tick();
		await settle();

		const events = eventsOfRun(rt.openDb(), job.id);
		assert.equal(events.length, 1, "the missing session start raises one event");
		assert.equal(events[0]?.condition, "startup_blocked");
		assert.equal(events[0]?.actionable, true);
		assert.equal(JSON.parse(events[0]?.payload ?? "{}").reason, "trust_dialog");

		tick();
		await settle();
		assert.equal(eventsOfRun(rt.openDb(), job.id).length, 1, "a second tick raises no second event");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the native monitor raises no event for a pane without the dialog", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-startup-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir, "Claude Code is ready");
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, createClaudeRunState(job.id));

		monitorNativeJob(rt, job, () => undefined);
		tick();
		await settle();

		assert.equal(eventsOfRun(rt.openDb(), job.id).length, 0);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the event of the trust dialog resolves when the session starts", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-startup-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir, DIALOG);
	try {
		const job = nativeJob(sessionDir);
		const state = createClaudeRunState(job.id);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, state);

		monitorNativeJob(rt, job, () => undefined);
		tick();
		await settle();
		assert.equal(pendingEvents(rt.openDb()).length, 1, "the event waits for the owner");

		applyObservation(state, {
			backend: "claude",
			runId: job.id,
			sessionId: null,
			source: "session.start",
			payload: { sessionId: "session-1" },
		});
		tick();
		await settle();

		assert.equal(pendingEvents(rt.openDb()).length, 0, "the started session resolves the event");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

/** A host that records the tools that the extension registers. */
interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
		extra?: unknown,
		fifth?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
}

/** A zod stub that accepts every parameter object. */
function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

test("the status tells the person to accept the trust dialog", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-startup-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const job = nativeJob(join(stateDir, "sessions", "wz-1"));
		rt.jobs.set(job.id, job);
		createEvent(
			rt.openDb(),
			"ev-wz-1-startup-startup_blocked",
			"wz-1|startup|startup_blocked",
			job.id,
			"startup_blocked",
			"startup_blocked",
			JSON.stringify({ reason: "trust_dialog" }),
			true,
			Date.now(),
		);

		const tools = new Map<string, FakeTool>();
		registerStatusTool({
			pi: {
				zod: fakeZod(),
				registerTool: (tool: FakeTool) => tools.set("status", tool),
			} as never,
			rt,
			deliver: () => undefined,
		});
		const tool = tools.get("status");
		assert.ok(tool, "the status tool was not registered");
		const result = await tool.execute("t1", {});
		assert.match(
			result.content[0]?.text ?? "",
			/The session waits at the trust dialog of Claude Code\. Accept it in the pane\./,
		);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

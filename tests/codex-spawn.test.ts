/**
 * The spawn of a Codex worker.
 *
 * A Codex worker starts an app server in a pane, a TUI in a second pane and
 * a turn in the thread of that server. The tests use fakes for the program
 * table, for the pane list and for the client of the app server.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import type { Job } from "../extensions/lib/job.ts";
import { loadRuns, persistRuns } from "../extensions/lib/runs.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import { type CodexFake, type CodexFakeOptions, codexFake } from "./codex-spawn-helpers.ts";

/**
 * The launch of one Codex worker.
 *
 * The helper runs the real function with the fake runtime. It returns the job
 * and the fake, so a test can read both.
 */
async function launch(
	options: CodexFakeOptions = {},
	model: string | null = null,
): Promise<{ job: Job; fake: CodexFake }> {
	const fake = codexFake(options);
	try {
		const job = await spawnCodexWorker(
			fake.rt,
			{
				jobId: "wz-codex-1",
				task: "Reply with the single word OK.",
				cwd: fake.dir,
				model,
			},
			{ connect: fake.connect, serverWaitMs: options.serverWaitMs ?? 100 },
		);
		return { job, fake };
	} finally {
		fake.rt.closeDb();
	}
}

/** The state of the attempt of a job. */
function attemptState(fake: CodexFake, jobId: string): string | null {
	const db: LifecycleDb = fake.rt.openDb();
	const row = db.handle.prepare("SELECT state FROM launch_attempts WHERE job_id = ?").get(jobId) as
		| { state: string }
		| undefined;
	return row?.state ?? null;
}

test("the calls of a launch run in the fixed order", async () => {
	const { fake } = await launch();
	assert.deepEqual(fake.order, [
		"server-pane",
		"initialize",
		"initialized",
		"thread/start",
		"thread/name/set",
		"thread/resume",
		"tui-pane",
		"turn/start",
	]);
});

test("no model reaches the thread when the job has none", async () => {
	const { fake } = await launch();
	const started = fake.clientCalls.find((call) => call.method === "thread/start");
	assert.ok(started, "the thread did not start");
	assert.equal(started.params.model, undefined);
});

test("no model reaches the TUI when the job has none", async () => {
	const { fake } = await launch();
	const tui = fake.weztermCalls.find((call) => call.includes("--remote"));
	assert.ok(tui, "the TUI did not start");
	assert.equal(tui.includes("-m"), false);
});

test("an explicit model reaches the thread", async () => {
	const { fake } = await launch({}, "gpt-6-luna");
	const started = fake.clientCalls.find((call) => call.method === "thread/start");
	assert.ok(started, "the thread did not start");
	assert.equal(started.params.model, "gpt-6-luna");
});

test("an explicit model reaches the TUI", async () => {
	const { fake } = await launch({}, "gpt-6-luna");
	const tui = fake.weztermCalls.find((call) => call.includes("--remote"));
	assert.ok(tui, "the TUI did not start");
	assert.equal(tui[tui.indexOf("-m") + 1], "gpt-6-luna");
});

test("the job holds the identity of the server", async () => {
	const { job } = await launch();
	assert.ok(job.codex, "the job holds no identity");
	assert.equal(job.codex.threadId, "thread-1");
	assert.equal(job.codex.serverPaneId, 11);
	assert.equal(job.codex.tuiPaneId, 12);
	assert.equal(job.codex.serverPid, 4200);
	assert.ok(job.codex.port > 0);
	assert.equal(job.nativeSessionId, "thread-1");
});

test("the pane of the job is the pane of the TUI", async () => {
	const { job } = await launch();
	assert.equal(job.paneId, 12);
});

test("a failure of the thread start closes both panes and ends the process", async () => {
	const { job, fake } = await launch({ failClientMethod: "thread/start" });
	assert.equal(job.status, "failed");
	assert.equal(fake.panes.size, 0, "a pane stayed open");
	assert.equal(fake.taskkills.length, 1, "the process of the server stayed alive");
	assert.equal(fake.killedPanes.includes(11), true);
	assert.equal(fake.killedPanes.includes(12), false);
});

test("a failure of the thread start marks the attempt unused", async () => {
	const { job, fake } = await launch({ failClientMethod: "thread/start" });
	assert.equal(attemptState(fake, job.id), "unused");
});

test("a failure of the TUI start closes both panes and ends the process", async () => {
	const { job, fake } = await launch({ failTuiLaunch: true });
	assert.equal(job.status, "failed");
	assert.equal(fake.panes.size, 0, "a pane stayed open");
	assert.equal(fake.taskkills.length, 1, "the process of the server stayed alive");
	assert.equal(fake.killedPanes.includes(11), true);
});

test("a failure of the TUI start marks the attempt unused", async () => {
	const { job, fake } = await launch({ failTuiLaunch: true });
	assert.equal(attemptState(fake, job.id), "unused");
});

test("a process of another name stays alive", async () => {
	const { job, fake } = await launch({ serverProcessName: "notepad.exe" });
	assert.equal(job.status, "failed", "the launch must refuse an unknown process");
	assert.equal(fake.taskkills.length, 0, "the process of the user must stay alive");
});

test("two matching processes refuse the launch and leave no pane", async () => {
	const { job, fake } = await launch({ serverProcessCount: 2 });
	assert.equal(job.status, "failed");
	assert.equal(fake.panes.size, 0, "a pane stayed open");
});

test("no matching process refuses the launch and leaves no pane", async () => {
	const { job, fake } = await launch({ serverProcessCount: 0 });
	assert.equal(job.status, "failed");
	assert.equal(fake.panes.size, 0, "a pane stayed open");
});

test("the job keeps its identity after a write and a read", async () => {
	const { job, fake } = await launch();
	const dir = fake.dir;
	const file = join(dir, "identity.db");
	let db: LifecycleDb | null = null;
	try {
		const open = openDatabase(file);
		db = open;
		persistRuns(open, null, [job]);
		const { alive, finished } = loadRuns(open);
		const stored = [...alive, ...finished].find((entry) => entry.id === job.id);
		assert.ok(stored, "the run did not come back");
		assert.deepEqual(stored.codex, job.codex);
		assert.equal(stored.nativeSessionId, "thread-1");
	} finally {
		db?.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

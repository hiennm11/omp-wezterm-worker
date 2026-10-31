/**
 * The re-attachment of a Codex worker after a restart of OMP.
 *
 * A restart loses the memory of a Codex run. The new owner finds the app
 * server through the identity of the job, proves that the process is the
 * same `codex.exe`, and connects to it again. The worker then reports to the
 * new owner, and it can be steered and stopped.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { attachWorker } from "../extensions/lib/attach.ts";
import { readHandover } from "../extensions/lib/bridge-handover.ts";
import type { CodexIdentity, Job } from "../extensions/lib/job.ts";
import { cancelJob } from "../extensions/lib/lifecycle.ts";
import { codexIdentityVerdict, reattachCodex } from "../extensions/lib/reattach-codex.ts";
import { type CodexFake, type CodexFakeOptions, codexFake } from "./codex-spawn-helpers.ts";

/** The port of the app server of the test. */
const PORT = 43210;

/** The process id of the app server of the test. */
const PID = 4200;

/** The thread of the worker of the test. */
const THREAD = "thread-1";

/** The turn that the app server of the test still runs. */
const OPEN_TURN = "turn-open";

/** The command line of an app server that holds a port. */
function serverCommandLine(port: number): string {
	return `"C:/fake/codex.exe" app-server --listen ws://127.0.0.1:${port}`;
}

/** The options of the fake of the test. */
function options(overrides: CodexFakeOptions = {}): CodexFakeOptions {
	return {
		seedProcesses: [{ pid: PID, name: "codex.exe", commandLine: serverCommandLine(PORT) }],
		openTurnId: OPEN_TURN,
		...overrides,
	};
}

/** The identity of a Codex worker of the test. */
function identity(overrides: Partial<CodexIdentity> = {}): CodexIdentity {
	return {
		port: PORT,
		serverPid: PID,
		threadId: THREAD,
		serverPaneId: 11,
		tuiPaneId: 12,
		binaryPath: "C:/fake/codex.exe",
		version: "codex-cli 0.166.0",
		...overrides,
	};
}

/** A Codex worker that runs, with its session directory. */
function codexJob(dir: string, codex: CodexIdentity | null = identity()): Job {
	const sessionDir = join(dir, "sessions", "wz-codex-restore");
	mkdirSync(sessionDir, { recursive: true });
	return {
		id: "wz-codex-restore",
		label: "test",
		task: "task",
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
		backend: "codex",
		nativeSessionId: THREAD,
		status: "running",
		paneId: 12,
		tabId: null,
		windowId: null,
		createdAt: Date.now(),
		startedAt: Date.now(),
		finishedAt: null,
		result: null,
		error: null,
		worktreeDirty: null,
		pendingStop: null,
		lastActivityAt: Date.now(),
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		usageBaseline: null,
		steers: 0,
		lastTranscriptSize: 0,
		paneClosed: false,
		codex,
	};
}

/** Close the runtime of a test. */
async function cleanup(fake: CodexFake): Promise<void> {
	await fake.closeBridges();
	fake.rt.closeDb();
	rmSync(fake.dir, { recursive: true, force: true });
}

test("the identity of a running app server passes the three checks", () => {
	const verdict = codexIdentityVerdict(
		[{ processId: PID, name: "codex.exe", commandLine: serverCommandLine(PORT) }],
		identity(),
	);
	assert.equal(verdict.ok, true, `the identity failed: ${verdict.reason}`);
	assert.equal(verdict.check, null);
});

test("a process that is gone fails the check of the process", () => {
	const verdict = codexIdentityVerdict([], identity());
	assert.equal(verdict.ok, false);
	assert.equal(verdict.check, "process");
	assert.match(verdict.reason, /4200/);
});

test("a process of another name fails the check of the name", () => {
	const verdict = codexIdentityVerdict(
		[{ processId: PID, name: "notepad.exe", commandLine: serverCommandLine(PORT) }],
		identity(),
	);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.check, "name");
	assert.match(verdict.reason, /notepad\.exe/);
});

test("an app server of another port fails the check of the command line", () => {
	const verdict = codexIdentityVerdict(
		[{ processId: PID, name: "codex.exe", commandLine: serverCommandLine(9999) }],
		identity(),
	);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.check, "command");
	assert.match(verdict.reason, /43210/);
});

test("a restored Codex worker gets a client, a run state and a handover file", async () => {
	const fake = codexFake(options());
	try {
		const job = codexJob(fake.dir);
		fake.rt.jobs.set(job.id, job);
		fake.panes.add(11);
		fake.panes.add(12);

		await reattachCodex(fake.rt, job, { connect: fake.connect });

		assert.ok(fake.rt.codexClients.has(job.id), "the client of the app server is missing");
		assert.ok(fake.rt.claudeStates.has(job.id), "the run state is missing");
		const handover = readHandover(job.sessionDir);
		assert.ok(handover, "the handover file is missing");
		assert.equal(handover.url, fake.rt.bridges.get(job.id)?.baseUrl);
		const resume = fake.clientCalls.find((call) => call.method === "thread/resume");
		assert.ok(resume, "the thread was not resumed");
		assert.equal(resume.params.threadId, THREAD);
		const spawns = fake.weztermCalls.filter((call) => call.includes("app-server"));
		assert.deepEqual(spawns, [], "a second app server started");
		assert.equal(fake.rt.jobs.size, 1, "a second worker exists");
	} finally {
		await cleanup(fake);
	}
});

test("a restored worker that fails the identity check is stopped as failed", async () => {
	const cases = [
		{ label: "the process is gone", rows: [], check: "process" },
		{
			label: "the name differs",
			rows: [{ pid: PID, name: "notepad.exe", commandLine: serverCommandLine(PORT) }],
			check: "name",
		},
		{
			label: "the command line holds another port",
			rows: [{ pid: PID, name: "codex.exe", commandLine: serverCommandLine(9999) }],
			check: "command",
		},
	];
	for (const testCase of cases) {
		const fake = codexFake(
			options({
				seedProcesses: testCase.rows.map((row) => ({
					pid: row.pid,
					name: row.name,
					commandLine: row.commandLine,
				})),
			}),
		);
		try {
			const job = codexJob(fake.dir);
			fake.rt.jobs.set(job.id, job);
			fake.panes.add(11);
			fake.panes.add(12);

			await attachWorker(fake.rt, job, () => undefined);

			assert.equal(job.status, "failed", `${testCase.label}: the worker did not fail`);
			assert.match(
				job.error ?? "",
				new RegExp(`check of the ${testCase.check}`),
				`${testCase.label}: ${job.error}`,
			);
			assert.deepEqual(fake.taskkills, [], `${testCase.label}: a program of the user ended`);
			assert.equal(fake.killedPanes.includes(11), true, `${testCase.label}: the server pane stayed open`);
			assert.equal(fake.killedPanes.includes(12), true, `${testCase.label}: the TUI pane stayed open`);
			assert.equal(job.codex?.serverPid, null, `${testCase.label}: the identity kept the process`);
		} finally {
			await cleanup(fake);
		}
	}
});

test("a stop of a restored worker interrupts the open turn", async () => {
	const fake = codexFake(options());
	try {
		const job = codexJob(fake.dir);
		fake.rt.jobs.set(job.id, job);
		fake.panes.add(11);
		fake.panes.add(12);

		await reattachCodex(fake.rt, job, { connect: fake.connect });
		const outcome = await cancelJob(fake.rt, job);

		assert.equal(outcome.stopped, true, `the stop failed: ${outcome.error}`);
		const interrupts = fake.clientCalls.filter((call) => call.method === "turn/interrupt");
		assert.equal(interrupts.length, 1, "the open turn was not interrupted");
		assert.equal(interrupts[0].params.threadId, THREAD);
		assert.equal(interrupts[0].params.turnId, OPEN_TURN);
	} finally {
		await cleanup(fake);
	}
});

test("a stop of a running worker ends no app server of another port", async () => {
	const fake = codexFake(
		options({
			seedProcesses: [{ pid: PID, name: "codex.exe", commandLine: serverCommandLine(9999) }],
		}),
	);
	try {
		const job = codexJob(fake.dir);
		fake.rt.jobs.set(job.id, job);
		fake.panes.add(11);
		fake.panes.add(12);

		const outcome = await cancelJob(fake.rt, job);

		assert.equal(outcome.stopped, true, `the stop failed: ${outcome.error}`);
		assert.deepEqual(fake.taskkills, [], "a program of the user ended");
	} finally {
		await cleanup(fake);
	}
});

/**
 * The takeover of a running Codex worker by another session.
 *
 * A release hands the worker over. The first session keeps no client and no
 * run state, so it can no longer observe the worker. A second session takes
 * the worker over through the re-attachment. It gets a client, a run state
 * and a handover file. The worker keeps its id, and no second app server and
 * no second worker start.
 *
 * The tests use the fakes of the Codex spawn, so no real program runs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readHandover } from "../extensions/lib/bridge-handover.ts";
import { connectCodexServer } from "../extensions/lib/codex-client.ts";
import type { CodexIdentity, Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { loadRuns } from "../extensions/lib/runs.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import { registerReleaseTool } from "../extensions/worker-tools/release.ts";
import { type CodexFake, type CodexFakeOptions, codexFake } from "./codex-spawn-helpers.ts";
import { startFakeWsServer } from "./codex-websocket-server.ts";
import { type FakeTool, fakeZod, takeOver } from "./takeover-helpers.ts";

/** The id of the worker of the test. */
const WORKER = "wz-codex-takeover";

/** The thread of the worker of the test. */
const THREAD = "thread-1";

/** The turn that the app server of the test still runs. */
const OPEN_TURN = "turn-open";

/** The session that owns the worker first. */
const FIRST = "session-first";

/** The session that takes the worker over. */
const SECOND = "session-second";

/** The pane of the app server of the test. */
const SERVER_PANE = 11;

/** The pane of the TUI of the test. */
const TUI_PANE = 12;

/** The options of the fake of the test. */
function options(overrides: CodexFakeOptions = {}): CodexFakeOptions {
	return { openTurnId: OPEN_TURN, ...overrides };
}

/**
 * A fake runtime that reads and writes the state directory of the test.
 *
 * The processes of the machine come from the given rows. A session that
 * takes a worker over must see the app server of that worker.
 */
function fakeIn(dir: string, seedProcesses: CodexFakeOptions["seedProcesses"] = []): CodexFake {
	const fake = codexFake(options({ seedProcesses }));
	fake.rt.config.stateDir = dir;
	fake.panes.add(SERVER_PANE);
	fake.panes.add(TUI_PANE);
	return fake;
}

/** The row of the process table that holds the app server of a worker. */
function serverRow(identity: CodexIdentity): { pid: number; name: string; commandLine: string } {
	return {
		pid: identity.serverPid ?? 0,
		name: "codex.exe",
		commandLine: `"C:/fake/codex.exe" app-server --listen ws://127.0.0.1:${identity.port}`,
	};
}

/** The release tool of the extension, with the given runtime. */
function releaseTool(rt: WorkerRuntime): FakeTool {
	const tools = new Map<string, FakeTool>();
	registerReleaseTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("release", tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("release");
	assert.ok(tool, "the release tool was not registered");
	return tool;
}

/**
 * Start a Codex worker in a pane of the fake.
 *
 * The session owns the task of the worker, so a release of that session can
 * move the authority.
 */
async function spawnFirst(fake: CodexFake): Promise<Job> {
	fake.rt.sessionId = FIRST;
	fake.rt.processId = 501;
	fake.rt.processStartedAt = "2026-10-23T01:00:00.000Z";
	const job = await spawnCodexWorker(
		fake.rt,
		{ jobId: WORKER, task: "Wait for 60 seconds and then report.", cwd: fake.dir },
		{ connect: fake.connect, serverWaitMs: 100 },
	);
	assert.equal(job.status, "running", `the worker did not start: ${job.error ?? "no reason"}`);
	acquireOwnership(
		fake.rt.openDb(),
		taskKey(job.id),
		FIRST,
		fake.rt.processId,
		fake.rt.processStartedAt,
		Date.now(),
	);
	fake.rt.persist();
	return job;
}

/**
 * A second session that reads the worker of the state directory.
 *
 * The session reads the worker from the database, so the test also proves
 * that the identity of the worker survives the write of the first session.
 */
function secondSession(fake: CodexFake): Job {
	fake.rt.sessionId = SECOND;
	fake.rt.processId = 502;
	fake.rt.processStartedAt = "2026-10-23T02:00:00.000Z";
	const { alive } = loadRuns(fake.rt.openDb());
	const job = alive.find((row) => row.id === WORKER);
	assert.ok(job, "the second session reads no worker");
	fake.rt.jobs.set(job.id, job);
	return job;
}

/** Close the runtimes of a test and remove its directory. */
async function cleanup(dir: string, ...fakes: Array<CodexFake | null>): Promise<void> {
	for (const fake of fakes) {
		if (!fake) continue;
		await fake.closeBridges();
		fake.rt.closeDb();
	}
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

test("a release of a Codex worker leaves no client and no run state behind", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
	const first = fakeIn(dir);
	try {
		const job = await spawnFirst(first);
		assert.equal(first.rt.codexClients.has(job.id), true, "the first session holds no client");
		assert.equal(first.rt.claudeStates.has(job.id), true, "the first session holds no run state");

		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });

		assert.equal(released.isError, undefined, released.content[0]?.text);
		assert.equal(released.details.released, true);
		assert.equal(first.rt.codexClients.has(job.id), false, "the first session kept the client");
		assert.equal(first.rt.claudeStates.has(job.id), false, "the first session kept the run state");
		assert.equal(first.rt.bridges.has(job.id), false, "the first session kept the bridge");
		assert.equal(job.status, "running", "the release stopped the worker");
		assert.deepEqual(first.killedPanes, [], "the release closed a pane");
		assert.deepEqual(first.taskkills, [], "the release ended a program");
		assert.equal(first.clientCloses, 1, "the release kept the socket of the client open");
	} finally {
		await cleanup(dir, first);
	}
});

test("a second session takes over a released Codex worker", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
	const first = fakeIn(dir);
	let second: CodexFake | null = null;
	try {
		const job = await spawnFirst(first);
		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });
		assert.equal(released.isError, undefined, released.content[0]?.text);

		second = fakeIn(dir, [serverRow(job.codex ?? ({ port: 0, serverPid: 0 } as CodexIdentity))]);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.taken, true);
		assert.equal(second.rt.codexClients.has(WORKER), true, "the new owner holds no client");
		assert.equal(second.rt.claudeStates.has(WORKER), true, "the new owner holds no run state");
		const handover = readHandover(taken.sessionDir);
		assert.ok(handover, "the new owner wrote no handover file");
		assert.equal(handover.url, second.rt.bridges.get(WORKER)?.baseUrl);
		const resume = second.clientCalls.find((call) => call.method === "thread/resume");
		assert.ok(resume, "the thread was not resumed");
		assert.equal(resume.params.threadId, THREAD);
		assert.deepEqual(
			second.weztermCalls.filter((call) => call.includes("app-server")),
			[],
			"a second app server started",
		);
		assert.equal(second.rt.jobs.size, 1, "a second worker exists");
		assert.equal(taken.id, WORKER, "the worker lost its id");
		assert.equal(taken.status, "running", "the worker stopped");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("a second session takes over a Codex worker of a dead first session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
	const first = fakeIn(dir);
	let second: CodexFake | null = null;
	try {
		const job = await spawnFirst(first);
		/* The owner row names a process that the machine no longer holds. */
		acquireOwnership(first.rt.openDb(), taskKey(job.id), FIRST, 900, "2026-10-22T08:00:00.000Z", 1100);

		second = fakeIn(dir, [serverRow(job.codex ?? ({ port: 0, serverPid: 0 } as CodexIdentity))]);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.taken, true);
		assert.equal(second.rt.codexClients.has(WORKER), true, "the new owner holds no client");
		assert.equal(second.rt.claudeStates.has(WORKER), true, "the new owner holds no run state");
		assert.ok(readHandover(taken.sessionDir), "the new owner wrote no handover file");
		assert.deepEqual(
			second.weztermCalls.filter((call) => call.includes("app-server")),
			[],
			"a second app server started",
		);
		assert.equal(second.rt.jobs.size, 1, "a second worker exists");
		assert.equal(taken.status, "running", "the worker stopped");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("a takeover of a Codex worker that fails the identity check stops it as failed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
	const first = fakeIn(dir);
	let second: CodexFake | null = null;
	try {
		const job = await spawnFirst(first);
		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });
		assert.equal(released.isError, undefined, released.content[0]?.text);
		/* The first session gave the worker away. It holds no client, so the
		   new owner is the only writer of the thread. */
		assert.equal(first.rt.codexClients.has(job.id), false, "the first session kept the client");

		/* The machine holds no app server of that worker any more. */
		second = fakeIn(dir);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.taken, true);
		assert.equal(taken.status, "failed", "the worker did not fail");
		assert.match(taken.error ?? "", /check of the process/, taken.error ?? "");
		assert.deepEqual(second.taskkills, [], "a program of the user ended");
		assert.equal(taken.codex?.serverPid, null, "the identity kept the process");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("the release of an OMP worker closes no bridge and ends no program", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
	const fake = fakeIn(dir);
	try {
		const job = await spawnFirst(fake);
		/* An OMP worker holds no bridge and no client. */
		const ompJob: Job = { ...job, backend: "omp" };
		fake.rt.jobs.set(ompJob.id, ompJob);
		fake.rt.claudeStates.delete(ompJob.id);

		const released = await releaseTool(fake.rt).execute("t1", { workerId: ompJob.id });

		assert.equal(released.isError, undefined, released.content[0]?.text);
		assert.equal(released.details.released, true);
		assert.equal(fake.rt.bridges.has(ompJob.id), false, "the release kept a bridge");
		assert.equal(fake.rt.codexClients.has(ompJob.id), false, "the release kept a client");
		assert.equal(ompJob.status, "running", "the release stopped the worker");
		assert.deepEqual(fake.killedPanes, [], "the release closed a pane");
		assert.deepEqual(fake.taskkills, [], "the release ended a program");
	} finally {
		await cleanup(dir, fake);
	}
});

test("the release of a Claude worker closes its bridge and keeps the worker", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-takeover-"));
	const fake = fakeIn(dir);
	try {
		const job = await spawnFirst(fake);
		const claudeJob: Job = { ...job, backend: "claude" };
		fake.rt.jobs.set(claudeJob.id, claudeJob);
		const state = fake.rt.claudeStates.get(claudeJob.id);
		assert.ok(state, "the run holds no state");

		const released = await releaseTool(fake.rt).execute("t1", { workerId: claudeJob.id });

		assert.equal(released.isError, undefined, released.content[0]?.text);
		assert.equal(released.details.released, true);
		assert.equal(fake.rt.bridges.has(claudeJob.id), false, "the release kept the bridge");
		assert.equal(fake.rt.claudeStates.has(claudeJob.id), false, "the release kept the run state");
		assert.equal(claudeJob.status, "running", "the release stopped the worker");
		assert.deepEqual(fake.killedPanes, [], "the release closed a pane");
		assert.deepEqual(fake.taskkills, [], "the release ended a program");
	} finally {
		await cleanup(dir, fake);
	}
});

test("a closed client of the app server delivers no message to its handler", async () => {
	const server = await startFakeWsServer();
	try {
		const client = await connectCodexServer(`ws://127.0.0.1:${server.port}`);
		const seen: string[] = [];
		client.setMessageHandler((message) => {
			seen.push(message.method ?? "no-method");
		});

		client.close();
		server.send(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
		/* The end of the connection comes after the data of the frame. The
		   test waits for it, so the client has read the frame. */
		await server.endConnection();

		assert.deepEqual(seen, [], "a closed client delivered a message to its handler");
	} finally {
		await server.close();
	}
});

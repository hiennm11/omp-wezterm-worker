/**
 * The launch of a Codex worker.
 *
 * The launch starts the app server in a pane, the TUI in a second pane and
 * the first turn of the thread. Every failure path ends the app server and
 * closes both panes, so a failed launch leaves no pane and no process on the
 * machine.
 */

import { REPORTING_CONTRACT } from "./bootstrap-prompt.ts";
import type { CodexBinary } from "./codex-binary.ts";
import { type CodexClient, connectCodexServer, threadIdOf } from "./codex-client.ts";
import {
	type CodexProcessRow,
	endCodexProcesses,
	findCodexServerProcesses,
	reserveFreePort,
} from "./codex-process.ts";
import type { CodexReportLaunch } from "./codex-report.ts";
import { attachCodexEvents } from "./codex-session.ts";
import type { CodexIdentity, Job } from "./job.ts";
import { launchProgram } from "./pane.ts";
import { delay } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** How long the launch waits for the process of the app server. */
const SERVER_WAIT_MS = 15_000;

/** The wait between two reads of the process table. */
const SERVER_POLL_MS = 500;

/** The seams of one Codex launch. A test replaces them. */
export interface CodexLaunchDeps {
	/** Connect to one app server. */
	connect?: (endpoint: string) => Promise<CodexClient>;
	/** How long the launch waits for the process of the app server. */
	serverWaitMs?: number;
}

/** The result of one Codex launch. */
export interface CodexLaunchResult {
	/** The reason that the launch failed, or null when it succeeded. */
	error: string | null;
	/** The id of the thread of the turn. */
	threadId: string;
}

/**
 * Start the app server, the TUI and the first turn of a Codex worker.
 */
export async function launchCodex(
	rt: WorkerRuntime,
	job: Job,
	binary: CodexBinary,
	report: CodexReportLaunch,
	deps: CodexLaunchDeps = {},
): Promise<CodexLaunchResult> {
	const port = await reserveFreePort();
	const endpoint = `ws://127.0.0.1:${port}`;

	const serverPaneId = await startServerPane(rt, job, binary, port, report);
	if (serverPaneId === null) {
		return { error: "the app server of Codex did not start.", threadId: "" };
	}

	const identity: CodexIdentity = {
		port,
		serverPid: null,
		threadId: "",
		serverPaneId,
		tuiPaneId: null,
		binaryPath: binary.bin,
		version: binary.version ?? "",
	};
	job.codex = identity;

	const servers = await waitForServerProcess(rt, port, deps.serverWaitMs ?? SERVER_WAIT_MS);
	if (servers.length !== 1) {
		await endCodexProcesses(rt, identity);
		return {
			error: `The app server of Codex is not identified. ${servers.length} processes hold the port ${port}.`,
			threadId: "",
		};
	}
	identity.serverPid = servers[0].processId;

	const connect = deps.connect ?? ((target: string) => connectCodexServer(target));
	let client: CodexClient;
	try {
		client = await connect(endpoint);
	} catch (e) {
		await endCodexProcesses(rt, identity);
		return { error: e instanceof Error ? e.message : String(e), threadId: "" };
	}

	const prepared = await prepareThread(client, job);
	if (prepared.error) {
		client.close();
		await endCodexProcesses(rt, identity);
		return { error: prepared.error, threadId: "" };
	}
	identity.threadId = prepared.threadId;
	job.nativeSessionId = prepared.threadId;

	/* The events of the app server fill the run state of the worker. The
	   spawn function made the run state with the bridge. The attachment
	   starts before the first turn, so no event is lost. */
	attachCodexEvents(rt, job, client);

	const tuiPaneId = await startTuiPane(rt, job, binary, port, prepared.threadId);
	if (tuiPaneId === null) {
		client.close();
		await endCodexProcesses(rt, identity);
		return { error: "the TUI of Codex did not start.", threadId: prepared.threadId };
	}
	identity.tuiPaneId = tuiPaneId;
	job.paneId = tuiPaneId;

	const turn = await client.request("turn/start", {
		threadId: prepared.threadId,
		input: [{ type: "text", text: job.task }],
	});
	if (turn.error) {
		client.close();
		await endCodexProcesses(rt, identity);
		return { error: `the first turn of Codex failed: ${turn.error.message}`, threadId: prepared.threadId };
	}

	return { error: null, threadId: prepared.threadId };
}

/**
 * Wait for the process of the app server.
 *
 * The pane starts before the process of the server appears in the table of
 * the machine. The function reads the table until the process appears or the
 * wait ends. It returns the processes that hold the port.
 */
async function waitForServerProcess(
	rt: WorkerRuntime,
	port: number,
	waitMs: number,
): Promise<CodexProcessRow[]> {
	const deadline = Date.now() + waitMs;
	let servers = await findCodexServerProcesses(rt, port);
	while (servers.length === 0 && Date.now() < deadline) {
		await delay(SERVER_POLL_MS);
		servers = await findCodexServerProcesses(rt, port);
	}
	return servers;
}

/**
 * Start the app server of Codex in a pane of its own.
 *
 * The pane starts through the command `wezterm cli spawn`, because the server
 * is not the program of the worker pane. The function returns the pane id, or
 * null when the pane did not start.
 */
async function startServerPane(
	rt: WorkerRuntime,
	job: Job,
	binary: CodexBinary,
	port: number,
	report: CodexReportLaunch,
): Promise<number | null> {
	const res = await rt.wezterm(
		[
			"spawn",
			"--cwd",
			job.cwd,
			"--",
			binary.bin,
			"app-server",
			"--listen",
			`ws://127.0.0.1:${port}`,
			...report.args,
		],
		report.env,
	);
	if (res.code !== 0) return null;
	const paneId = Number.parseInt(res.stdout.trim(), 10);
	return Number.isFinite(paneId) ? paneId : null;
}

/**
 * Start the TUI of Codex in a second pane.
 *
 * The TUI attaches to the thread of the client. The model goes to the TUI
 * only when the job names one. The function returns the pane id, or null
 * when the pane did not start.
 */
async function startTuiPane(
	rt: WorkerRuntime,
	job: Job,
	binary: CodexBinary,
	port: number,
	threadId: string,
): Promise<number | null> {
	const args = ["--remote", `ws://127.0.0.1:${port}`, "resume", threadId];
	if (job.model) args.push("-m", job.model);
	const failure = await launchProgram(rt, job, binary.bin, args);
	if (failure) return null;
	return job.paneId;
}

/** The result of the preparation of the thread of a Codex worker. */
interface ThreadResult {
	/** The reason that the preparation failed, or null when it succeeded. */
	error: string | null;
	/** The id of the thread. */
	threadId: string;
}

/**
 * Prepare the thread of a Codex worker.
 *
 * The order of the calls is fixed. The request `thread/start` alone writes no
 * rollout file, and the TUI then ends at once. The request `thread/name/set`
 * writes that file, and the request `thread/resume` makes the server load it.
 */
async function prepareThread(client: CodexClient, job: Job): Promise<ThreadResult> {
	const started = await client.request("thread/start", threadStartParams(job));
	if (started.error) return { error: `the thread of Codex failed: ${started.error.message}`, threadId: "" };
	const threadId = threadIdOf(started);
	if (!threadId) return { error: "the thread of Codex holds no id.", threadId: "" };

	const named = await client.request("thread/name/set", { threadId, name: job.id });
	if (named.error) return { error: `the name of the thread failed: ${named.error.message}`, threadId: "" };

	const resumed = await client.request("thread/resume", { threadId });
	if (resumed.error)
		return { error: `the thread of Codex did not resume: ${resumed.error.message}`, threadId: "" };

	return { error: null, threadId };
}

/**
 * The parameters of the request `thread/start`.
 *
 * The model goes to the request only when the job names one. An omitted
 * model uses the default of Codex. The field `developerInstructions` carries
 * the reporting contract, so the worker knows how to report its task state.
 */
function threadStartParams(job: Job): Record<string, unknown> {
	const params: Record<string, unknown> = { cwd: job.cwd, developerInstructions: REPORTING_CONTRACT };
	if (job.model) params.model = job.model;
	return params;
}

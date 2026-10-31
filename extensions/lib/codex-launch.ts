/**
 * The launch of a Codex worker.
 *
 * The launch starts the app server in a pane, the TUI in a second pane and
 * the first turn of the thread. Every failure path ends the app server and
 * closes both panes, so a failed launch leaves no pane and no process on the
 * machine.
 */

import type { CodexBinary } from "./codex-binary.ts";
import { type CodexClient, connectCodexServer } from "./codex-client.ts";
import {
	type CodexProcessRow,
	endCodexProcesses,
	findCodexServerProcesses,
	reserveFreePort,
} from "./codex-process.ts";
import type { CodexReportLaunch } from "./codex-report.ts";
import { attachCodexEvents } from "./codex-session.ts";
import { resumeThread, startThread } from "./codex-thread.ts";
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
 * The thread that a launch continues.
 *
 * A new launch starts a thread. A resume continues the thread of a source
 * run, so the worker comes back with its history.
 */
export interface CodexResumeTarget {
	/** The id of the thread of the source run. */
	threadId: string;
	/** The follow-up instruction, when the owner gave one. */
	message?: string;
}

/** The options of one Codex launch. */
export interface CodexLaunchOptions {
	/** Continue a thread instead of starting a new one. */
	resume?: CodexResumeTarget;
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
	options: CodexLaunchOptions = {},
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

	const prepared = options.resume
		? await resumeThread(client, options.resume.threadId)
		: await startThread(client, job);
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

	/* A new worker sends its task as the first turn. A resumed worker sends
	   the instruction of the owner, and only when the owner gave one. A
	   resume without an instruction opens the thread and starts no turn. */
	if (options.resume) {
		const message = options.resume.message;
		if (!message) return { error: null, threadId: prepared.threadId };
		const turn = await client.request("turn/start", {
			threadId: prepared.threadId,
			input: [{ type: "text", text: message }],
		});
		if (turn.error) {
			client.close();
			await endCodexProcesses(rt, identity);
			return {
				error: `the first turn of Codex failed: ${turn.error.message}`,
				threadId: prepared.threadId,
			};
		}
		return { error: null, threadId: prepared.threadId };
	}

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

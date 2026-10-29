import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import {
	type AppServerClient,
	connectAppServer,
	endpointFor,
	observationOf,
	reportServerArgs,
} from "./codex.ts";
import type { EvidenceStore } from "./evidence.ts";
import { type ProofListener, startListener } from "./listener.ts";
import type { ScenarioOutcome } from "./scenarios.ts";
import { type ProofArgs, runProgram } from "./shared.ts";

/** The model that the proof uses for a Codex session. */
export const PROOF_CODEX_MODEL = "gpt-6-luna";

/** The Codex binary of the machine. */
export interface CodexBinary {
	/** The path of the binary. */
	bin: string;
	/** The version of the binary, or null when it holds no version. */
	version: string | null;
}

/** The options that one proof run passes to the Codex scenarios. */
export interface CodexProofOptions {
	/** The arguments of the runner. */
	args: ProofArgs;
	/** The proof run id. */
	runId: string;
	/** The evidence store of the run. */
	evidence: EvidenceStore;
	/** The observations that the listener received. */
	observations: Array<{ source: string; payload: unknown }>;
	/** The Codex binary that the runner found. */
	binary?: CodexBinary | null;
}

/** The result of one proof run. */
export interface ProofOutcome {
	/** The verdict of the run. */
	verdict: "pass" | "fail" | "unavailable";
	/** The result of each scenario. */
	results: ScenarioOutcome[];
}

/** The state that one Codex scenario shares. */
interface CodexHandle {
	client: Awaited<ReturnType<typeof connectAppServer>>;
	threadId: string;
	port: number;
	listener: ProofListener;
	paneId: number | null;
	serverPid: number | null;
	fixture: string;
}

/** Wait for a number of milliseconds. */
export function wait(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** The path of the report server of the proof. */
function reportServerPath(): string {
	return join(import.meta.dirname, "report-server.ts");
}

/**
 * Find the Codex binary of the machine.
 *
 * The proof prefers the build that the native queue contract needs. A Node
 * spawn of `codex` resolves to the stale desktop install on this machine, so
 * the proof looks for the npm build first and records the version that it
 * used.
 */
export async function findCodexBinary(): Promise<CodexBinary | null> {
	const candidates = [
		"C:/Program Files/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
	];
	for (const bin of candidates) {
		if (!existsSync(bin)) continue;
		const result = await runProgram(bin, ["--version"]);
		if (result.code === 0) {
			return { bin, version: result.stdout.trim() };
		}
	}
	const fallback = await runProgram("cmd.exe", ["/c", "codex", "--version"]);
	if (fallback.code === 0) return { bin: "cmd.exe", version: fallback.stdout.trim() };
	return null;
}

/**
 * Reserve a loopback port.
 *
 * The reservation is released before the app server binds the port.
 */
export async function reservePort(): Promise<number> {
	const server = createServer();
	const { promise, resolve } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		server.close(() => resolve(port));
	});
	return promise;
}

/**
 * Start one dedicated app server and connect the observer.
 *
 * The server runs in a proof-owned pane. The observer connects to the exact
 * endpoint of that server.
 */
export async function startServer(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
	scenario: string,
): Promise<{ handle: CodexHandle | null; error: string | null; reason: string | null }> {
	const port = await reservePort();
	const listener = await startListener((payload) => {
		const record = payload as { source?: string; payload?: unknown };
		const source = record.source ?? "unknown";
		const body = record.payload ?? null;
		options.evidence.observe(scenario, source, body);
		options.observations.push({ source, payload: body });
	});
	const env = {
		WEZTERM_PROOF_RUN_ID: options.runId,
		WEZTERM_PROOF_URL: listener.baseUrl,
		WEZTERM_PROOF_TOKEN: listener.token,
	};

	const serverArgs = [
		"app-server",
		"--listen",
		`ws://127.0.0.1:${port}`,
		...reportServerArgs(reportServerPath()),
	];
	const launched = await runProgram(
		"wezterm",
		["cli", "spawn", "--cwd", fixture, "--", bin, ...serverArgs],
		undefined,
		env,
	);
	if (launched.code !== 0) {
		await listener.close();
		return { handle: null, error: (launched.stderr || launched.stdout).trim(), reason: null };
	}
	const paneId = Number.parseInt(launched.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
		await listener.close();
		return { handle: null, error: "wezterm did not return a pane id", reason: null };
	}

	await wait(3000);
	const serverProcess = await readCodexProcesses(port);
	if (serverProcess.pid === null) {
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
		await listener.close();
		return {
			handle: null,
			error: "no process matches the launched app server",
			reason: "the process identity is ambiguous",
		};
	}

	let client: Awaited<ReturnType<typeof connectAppServer>>;
	try {
		client = await connectAppServer(endpointFor(port));
	} catch (error) {
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
		await listener.close();
		return { handle: null, error: String(error), reason: null };
	}

	const started = await client.request("thread/start", { cwd: fixture, model: PROOF_CODEX_MODEL });
	if (started.error) {
		client.close();
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
		await listener.close();
		return { handle: null, error: started.error.message, reason: null };
	}
	const thread = started.result as { thread?: { id?: string } } | undefined;
	const threadId = thread?.thread?.id ?? "";
	client.threadId = threadId;

	const status = await client.request("mcpServerStatus/list", { threadId });
	const servers = (status.result as { data?: Array<{ name?: string }> } | undefined)?.data ?? [];
	const names = servers.map((server) => server.name ?? "");
	if (!names.includes("wezterm_worker_proof")) {
		client.close();
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
		await listener.close();
		return {
			handle: null,
			error: `the proof report server did not appear; the servers are ${names.join(", ")}`,
			reason: null,
		};
	}

	/* The request `thread/start` makes a thread that has no rollout file. The
	   command `resume` of the TUI needs that file. The request
	   `thread/name/set` writes the file, and the request `thread/resume`
	   makes the server load it. Both calls go through the client, so the
	   evidence file holds them. */
	const named = await client.request("thread/name/set", { threadId, name: "proof-worker" });
	if (named.error) {
		client.close();
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
		await listener.close();
		return { handle: null, error: named.error.message, reason: null };
	}
	const resumed = await client.request("thread/resume", { threadId });
	if (resumed.error) {
		client.close();
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
		await listener.close();
		return { handle: null, error: resumed.error.message, reason: null };
	}

	return {
		handle: {
			client,
			threadId,
			port,
			listener,
			paneId,
			serverPid: serverProcess.pid,
			fixture,
		},
		error: null,
		reason: null,
	};
}

/** Read the Codex processes that match an endpoint. */
export async function readCodexProcesses(
	port: number,
): Promise<{ pid: number | null; created: string | null }> {
	const result = await runProgram("powershell", [
		"-NoProfile",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | ` +
			`Where-Object { $_.CommandLine -like '*app-server*${port}*' } | ` +
			`ForEach-Object { "$($_.ProcessId)|$($_.CreationDate)" }`,
	]);
	const line = result.stdout.trim().split("\n")[0] ?? "";
	const [pid, created] = line.split("|");
	const parsed = Number.parseInt(pid ?? "", 10);
	if (!Number.isFinite(parsed)) return { pid: null, created: null };
	return { pid: parsed, created: created ?? null };
}

/** Attach the real Codex TUI to a thread. */
export async function attachTui(
	handle: CodexHandle,
	bin: string,
	env: Record<string, string>,
): Promise<{ paneId: number | null; error: string | null }> {
	const result = await runProgram(
		"wezterm",
		[
			"cli",
			"spawn",
			"--cwd",
			handle.fixture,
			"--",
			bin,
			"--remote",
			endpointFor(handle.port),
			"resume",
			handle.threadId,
			"-m",
			PROOF_CODEX_MODEL,
		],
		undefined,
		env,
	);
	if (result.code !== 0) return { paneId: null, error: (result.stderr || result.stdout).trim() };
	const paneId = Number.parseInt(result.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) return { paneId: null, error: "wezterm did not return a pane id" };
	return { paneId, error: null };
}

/** Close the panes of a handle. */
export async function stopHandle(handle: CodexHandle): Promise<void> {
	if (handle.paneId !== null) {
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(handle.paneId)]);
	}
	handle.client.close();
	await handle.listener.close();
}

/**
 * Record the native events of the app server as observations.
 *
 * Every protocol message of the app server becomes one line of the evidence
 * file. The file holds both directions, so a reader sees the request that
 * never got a response. The observations of the run keep their old shape:
 * they hold the notifications and the requests of the server.
 */
export function recordMessages(options: CodexProofOptions, client: AppServerClient, scenario: string): void {
	for (const message of client.messages) {
		const observation = observationOf(message);
		options.evidence.observe(scenario, observation.source, observation.payload);
		if (!message.method) continue;
		options.observations.push({ source: observation.source, payload: observation.payload });
	}
	for (const message of client.sent) {
		const observation = observationOf(message);
		options.evidence.observe(scenario, observation.source, observation.payload);
	}
}

/**
 * The handle of one Codex scenario and the rules of its evidence.
 *
 * The handle names the pane of the app server and the pane of the TUI
 * apart. A scenario sets the pane of the TUI. It never sets the pane of the
 * server. The stop of a scenario closes both panes and ends the process of
 * the server.
 *
 * The rules of a verdict are pure functions. A test can check them without a
 * pane.
 */

import type { AppServerClient } from "./codex.ts";
import type { EvidenceStore, Verdict } from "./evidence.ts";
import type { ProofListener } from "./listener.ts";
import type { ScenarioOutcome } from "./scenarios.ts";
import { type ProofArgs, runProgram } from "./shared.ts";

/** The name of the process that the proof may end. */
const CODEX_PROCESS_NAME = "codex.exe";

/** The Codex binary of the machine. */
export interface CodexBinary {
	/** The path of the binary. */
	bin: string;
	/** The version of the binary, or null when it holds no version. */
	version: string | null;
}

/** One observation that a Codex scenario made. */
export interface CodexObservation {
	/** The native event or call that produced the observation. */
	source: string;
	/** The native payload, unchanged. */
	payload: unknown;
	/** The time of the observation, in epoch milliseconds. */
	at: number;
}

/** The options that one proof run passes to the Codex scenarios. */
export interface CodexProofOptions {
	/** The arguments of the runner. */
	args: ProofArgs;
	/** The proof run id. */
	runId: string;
	/** The evidence store of the run. */
	evidence: EvidenceStore;
	/** The observations that one scenario made. */
	observations: CodexObservation[];
	/** The Codex binary that the runner found. */
	binary?: CodexBinary | null;
}

/** The state that one Codex scenario shares. */
export interface CodexHandle {
	/** The client of the app server. */
	client: AppServerClient;
	/** The thread of the scenario. */
	threadId: string;
	/** The port of the app server. */
	port: number;
	/** The listener that holds the reports of the scenario. */
	listener: ProofListener;
	/** The pane of the app server. The server sets this field. */
	serverPaneId: number | null;
	/** The pane of the TUI. A scenario sets this field. */
	tuiPaneId: number | null;
	/** The process of the app server. */
	serverPid: number | null;
	/** The working directory of the scenario. */
	fixture: string;
}

/**
 * Make the options of one scenario.
 *
 * The function gives the scenario a list of observations of its own. The
 * evidence store stays the store of the run, so the file of the run holds
 * the lines of every scenario.
 */
export function optionsForScenario(options: CodexProofOptions): CodexProofOptions {
	return { ...options, observations: [] };
}

/**
 * The verdict of a scenario that wrote evidence.
 *
 * The function keeps the verdict of the scenario when the scenario wrote at
 * least one line of evidence. Otherwise the verdict is `fail` and the detail
 * names the missing evidence. A scenario that recorded nothing cannot pass.
 */
export function verdictWithEvidence(
	scenario: string,
	verdict: Verdict,
	detail: string,
	evidenceLines: number,
): ScenarioOutcome {
	if (evidenceLines > 0) return { scenario, verdict, detail };
	return { scenario, verdict: "fail", detail: "the scenario wrote no evidence" };
}

/**
 * The name of the process that the proof may end.
 *
 * The function returns true only for `codex.exe`. A pid that the system gave
 * to another program of the user must not end that program.
 */
export function mayEndCodexProcess(name: string): boolean {
	return name.trim().toLowerCase() === CODEX_PROCESS_NAME;
}

/**
 * Read the name of the process of a pid.
 *
 * The function returns null when the pid names no process.
 */
async function readProcessName(pid: number): Promise<string | null> {
	const result = await runProgram("powershell", [
		"-NoProfile",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ForEach-Object { $_.Name }`,
	]);
	const name = result.stdout.trim().split("\n")[0]?.trim() ?? "";
	return name ? name : null;
}

/**
 * End the process of the app server and its children.
 *
 * The function reads the name of the process before it ends it. A pid that
 * the system reused for another program stays alive. The command `taskkill`
 * ends the child processes too, so the host of the code mode ends with it.
 */
async function endServerProcess(handle: CodexHandle): Promise<void> {
	const pid = handle.serverPid;
	if (pid === null) return;
	const name = await readProcessName(pid);
	if (name === null) return;
	if (!mayEndCodexProcess(name)) return;
	await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

/**
 * Close the panes and the process of one handle.
 *
 * The function ends the process of the server first. The pane of the server
 * still holds that process, so the pid cannot change to another program
 * between the check of the name and the kill. Then the function closes the
 * pane of the TUI and the pane of the server.
 */
export async function stopHandle(handle: CodexHandle): Promise<void> {
	await endServerProcess(handle);
	if (handle.tuiPaneId !== null) {
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(handle.tuiPaneId)]);
	}
	if (handle.serverPaneId !== null) {
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(handle.serverPaneId)]);
	}
	handle.client.close();
	await handle.listener.close();
}

/**
 * Run one scenario with its own list of observations.
 *
 * The function gives the scenario a list of observations of its own. A
 * verdict reads only that list. The function also applies the rule of the
 * evidence: a scenario that wrote no line of evidence cannot pass.
 */
export async function runScenario(
	scenario: string,
	options: CodexProofOptions,
	work: (own: CodexProofOptions) => Promise<ScenarioOutcome>,
): Promise<ScenarioOutcome> {
	const own = optionsForScenario(options);
	const outcome = await work(own);
	return verdictWithEvidence(scenario, outcome.verdict, outcome.detail, own.evidence.count(scenario));
}

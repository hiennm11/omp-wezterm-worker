/**
 * The shared helpers of the Claude scenarios.
 *
 * Every scenario owns one native session. These helpers start that session,
 * close it, and record what it sent. The scenarios themselves live in
 * `claude-run.ts`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { answerStartupPrompts, launchSession, paneText, sendCommand, typeIntoPane } from "./claude.ts";

export { answerStartupPrompts, paneText, sendCommand, typeIntoPane };

import type { EvidenceStore } from "./evidence.ts";
import { type ProofListener, startListener } from "./listener.ts";
import { createReducerState } from "./reducer.ts";
import { feedObservations } from "./scenarios.ts";
import { type ProofArgs, runProgram } from "./shared.ts";

/** The options that one proof run passes to the Claude scenarios. */
export interface ClaudeProofOptions {
	/** The arguments of the runner. */
	args: ProofArgs;
	/** The proof run id. */
	runId: string;
	/** The evidence store of the run. */
	evidence: EvidenceStore;
	/** The observations that the listener received. */
	observations: Array<{ source: string; payload: unknown }>;
}

/** The state that one Claude scenario shares. */
export interface SessionHandle {
	/** The native session id of the session. */
	sessionId: string;
	/** The proof run id that the session belongs to. */
	runId: string;
	/** The pane that holds the session. */
	paneId: number;
	/** The directory of the fixture that the session works in. */
	fixture: string;
	/** The directory of the plugin copy that the session loads. */
	pluginDir: string;
	/** The listener that receives the observations. */
	listener: ProofListener;
}

/** Wait for a number of milliseconds. */
export function wait(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Record one observation that the native program sent.
 *
 * The observation reaches the evidence file once and the in-memory list of
 * the run. The mod sends the same observation twice after a reconnect, so
 * the evidence file must hold it once.
 */
export function recordObservation(options: ClaudeProofOptions, scenario: string, payload: unknown): void {
	options.observations.push(payload as { source: string; payload: unknown });
	options.evidence.observe(
		scenario,
		(payload as { source?: string })?.source ?? "unknown",
		(payload as { payload?: unknown })?.payload ?? payload,
	);
}

/** Start one Claude session under proof. */
export async function startSession(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
	scenario = "session",
	runId = options.runId,
	settings?: string,
): Promise<{ handle: SessionHandle | null; error: string | null }> {
	const sessionId = randomUUID();
	const listener = await startListener((payload) => recordObservation(options, scenario, payload));
	const env = {
		WEZTERM_PROOF_RUN_ID: runId,
		WEZTERM_PROOF_URL: listener.baseUrl,
		WEZTERM_PROOF_TOKEN: listener.token,
	};
	const launched = await launchSession({ sessionId, fixture, pluginDir, env, settings });
	options.evidence.observe(scenario, "session.launch", {
		paneId: launched.paneId,
		error: launched.error,
	});
	if (launched.paneId === null) {
		await listener.close();
		return { handle: null, error: launched.error ?? "the pane did not start" };
	}
	const handle: SessionHandle = { sessionId, runId, paneId: launched.paneId, fixture, pluginDir, listener };
	const prompts = await answerStartupPrompts(launched.paneId);
	options.evidence.observe(scenario, "session.trust", prompts);
	return { handle, error: null };
}

/** Close the pane of a session and stop its listener. */
export async function stopSession(handle: SessionHandle): Promise<void> {
	await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(handle.paneId)]);
	await handle.listener.close();
}

/** Send one command to the mod through the listener of a session. */
export async function queueCommand(handle: SessionHandle, runId: string, text: string): Promise<string> {
	return sendCommand(handle.listener, runId, text);
}

/** Type one instruction into the pane of a session. */
export async function typeInstruction(handle: SessionHandle, text: string): Promise<void> {
	await typeIntoPane(handle.paneId, text);
}

/** Read the visible text of a pane. */
export async function paneLines(paneId: number, lines: number): Promise<string> {
	return paneText(paneId, lines);
}

/** The pane ids that WezTerm holds. */
export async function listPanes(): Promise<number[]> {
	const result = await runProgram("wezterm", ["cli", "list", "--format", "json"]);
	try {
		const panes = JSON.parse(result.stdout) as Array<{ pane_id: number }>;
		return panes.map((pane) => pane.pane_id);
	} catch {
		return [];
	}
}

/** The number of Claude processes that the machine holds. */
export async function countClaudeProcesses(): Promise<number> {
	const result = await runProgram("powershell", [
		"-NoProfile",
		"-Command",
		"@(Get-CimInstance Win32_Process -Filter \"Name = 'claude.exe'\").Count",
	]);
	const count = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(count) ? count : -1;
}

/** The directories that hold the Claude projects of the machine. */
export function claudeProjectDirs(): string[] {
	const home = process.env.USERPROFILE ?? "";
	const root = join(home, ".claude", "projects");
	if (!existsSync(root)) return [];
	return readdirSync(root);
}

/** The summary of the inherited Claude settings. It holds no secret. */
export function readSettingsSummary(): { visible: string } {
	const home = process.env.USERPROFILE ?? "";
	const path = join(home, ".claude", "settings.json");
	if (!existsSync(path)) return { visible: "no settings file" };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			enabledPlugins?: unknown;
			permissions?: unknown;
		};
		const plugins = Array.isArray(parsed.enabledPlugins) ? parsed.enabledPlugins.length : 0;
		return { visible: `${plugins} enabled plugin(s)` };
	} catch {
		return { visible: "the settings file could not be read" };
	}
}

/**
 * Wait until the reducer holds a valid completion report.
 *
 * The function returns the detail of the outcome. It never reports a success
 * that the observations do not prove.
 */
export async function waitForReport(
	handle: SessionHandle,
	options: {
		observations: Array<{ source: string; payload: unknown }>;
		evidence: EvidenceStore;
		scenario: string;
		deadlineMs: number;
		runId?: string;
	},
): Promise<{ ok: boolean; detail: string }> {
	const deadline = Date.now() + options.deadlineMs;
	while (Date.now() < deadline) {
		const fed = feedObservations(createReducerState(options.runId ?? handle.runId), options.observations);
		const report = fed.state.latestReport;
		if (report && report.state === "completed" && fed.blockers.length === 0) {
			return { ok: true, detail: `the report ${report.result} settled the cycle` };
		}
		await wait(1000);
	}
	return { ok: false, detail: "no valid completion report within the limit" };
}

/**
 * Wait until the native session ends a turn.
 *
 * The function returns true when a turn ended. It never claims a turn ended
 * that the observations do not show.
 */
export async function waitForTurnEnd(options: ClaudeProofOptions, deadlineMs: number): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		const ended = options.observations.some((o) => o.source === "turn.complete");
		if (ended) return true;
		await wait(1000);
	}
	return false;
}

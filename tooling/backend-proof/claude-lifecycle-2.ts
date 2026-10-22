/**
 * The Claude scenarios of the background work, the recovery and the stop.
 *
 * The scenarios share one reducer, so the rules of a completion report are the
 * same for both backends. Every scenario owns one native session with its own
 * session id.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
	type ClaudeProofOptions,
	countClaudeProcesses,
	listPanes,
	recordObservation,
	startSession,
	stopSession,
	typeIntoPane,
	wait,
	waitForReport,
} from "./claude-session.ts";
import { startListener } from "./listener.ts";
import type { ScenarioOutcome } from "./scenarios.ts";
import { runProgram, SCENARIO_LIMIT_SECONDS } from "./shared.ts";

/**
 * Run the background scenario.
 *
 * The scenario asks for a native background task and for a completion report
 * before the task ends. The proof reads the settlement of the background task
 * from the native notification row, so the settlement of the background task
 * stays apart from the return of the foreground tool.
 */
export async function runBackground(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "background";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		await typeIntoPane(
			handle.paneId,
			"Run a background shell task that writes BG-DONE to bg.txt after 15 seconds. Wait for it. Then report completed with result PROOF-BACKGROUND.",
		);
		const deadline = Date.now() + SCENARIO_LIMIT_SECONDS * 1000;
		let settled: typeof options.observations = [];
		while (Date.now() < deadline) {
			settled = options.observations.filter((o) => o.source === "background.settled");
			if (settled.length > 0) break;
			await wait(1000);
		}
		const backgrounds = options.observations.filter((o) => o.source === "background.settled");
		const reports = options.observations.filter((o) => o.source === "report");
		const calls = options.observations.filter((o) => o.source === "tool.call.settled");
		const hasBg = existsSync(join(fixture, "bg.txt"));
		const detail = `${backgrounds.length} background settlement(s), ${calls.length} foreground settlement(s), ${reports.length} report(s), background file: ${hasBg}`;
		if (backgrounds.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: `no native settlement of the background task; ${detail}`,
			};
		}
		if (calls.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: `no native settlement of the foreground call; ${detail}`,
			};
		}
		if (!hasBg) {
			return { scenario, verdict: "fail", detail: `the background task wrote no file; ${detail}` };
		}
		return { scenario, verdict: "pass", detail };
	} finally {
		await stopSession(handle);
	}
}

/** Run the recovery scenario. */
export async function runRecovery(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "recovery";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		await typeIntoPane(handle.paneId, "Read baseline.txt, then report completed with result PROOF-RECOVERY.");
		await wait(12000);
		const before = options.observations.length;
		const saved = handle.listener.state();
		await handle.listener.close();
		/* The recovery restores the same listener. A native session that
		   already runs keeps the address and the token that it read. */
		const reopened = await startListener((payload) => recordObservation(options, scenario, payload), saved);
		handle.listener = reopened;
		await typeIntoPane(handle.paneId, "Read baseline.txt and report completed with result PROOF-RECOVERY-2.");
		/* The proof waits for the report that follows the reconnect. */
		const deadline = Date.now() + SCENARIO_LIMIT_SECONDS * 1000;
		while (Date.now() < deadline) {
			const found = options.observations
				.slice(before)
				.some(
					(o) =>
						o.source === "report" &&
						String((o.payload as { result?: string })?.result ?? "") === "PROOF-RECOVERY-2",
				);
			if (found) break;
			await wait(1000);
		}
		const after = options.observations.slice(before);
		const recovered = after.filter(
			(o) =>
				o.source === "report" &&
				String((o.payload as { result?: string })?.result ?? "") === "PROOF-RECOVERY-2",
		);
		if (recovered.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: "the session produced no report after the reconnect",
			};
		}
		const result = await waitForReport(handle, {
			observations: options.observations.slice(before),
			evidence: options.evidence,
			scenario,
			deadlineMs: SCENARIO_LIMIT_SECONDS * 1000,
		});
		const starts = options.observations.slice(before).filter((o) => o.source === "session.start").length;
		return {
			scenario,
			verdict: result.ok && starts === 1 ? "pass" : "fail",
			detail: `${result.detail}; ${starts} native session start(s), so no replacement worker started`,
		};
	} finally {
		await stopSession(handle);
	}
}

/** Run the stop scenario. */
export async function runStop(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "stop";
	const before = await listPanes();
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		await typeIntoPane(handle.paneId, "Run a foreground command that waits 30 seconds.");
		await wait(6000);
		const beforeProcesses = await countClaudeProcesses();
		await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(handle.paneId)]);
		await wait(3000);
		const after = await listPanes();
		const gone = !after.includes(handle.paneId);
		const othersSurvived = before.every((pane) => after.includes(pane));
		/* The backend process must end too. A missing pane is not a stop. */
		const processes = await countClaudeProcesses();
		const ended = processes >= 0 && processes < beforeProcesses;
		return {
			scenario,
			verdict: gone && othersSurvived && ended ? "pass" : "fail",
			detail: `the pane is gone: ${gone}; unrelated panes survive: ${othersSurvived}; claude processes: ${beforeProcesses} before, ${processes} after`,
		};
	} finally {
		await stopSession(handle);
	}
}

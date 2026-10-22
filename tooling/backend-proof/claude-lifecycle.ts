/**
 * The Claude scenarios that continue a run and that ask a permission.
 *
 * The scenarios share one reducer, so the rules of a completion report are the
 * same for both backends. Every scenario owns one native session with its own
 * session id.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { answerStartupPrompts, writeAskSettings } from "./claude.ts";
import {
	type ClaudeProofOptions,
	paneText,
	recordObservation,
	type SessionHandle,
	sendCommand,
	startSession,
	stopSession,
	typeIntoPane,
	wait,
	waitForReport,
	waitForTurnEnd,
} from "./claude-session.ts";
import { startListener } from "./listener.ts";
import { resultsByPhase, type ScenarioOutcome } from "./scenarios.ts";
import { runProgram, SCENARIO_LIMIT_SECONDS } from "./shared.ts";

/** Run the resume scenario. */
export async function runResume(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "resume";
	const first = await startSession(options, fixture, pluginDir, scenario);
	if (!first.handle) {
		return { scenario, verdict: "unavailable", detail: first.error ?? "the session did not start" };
	}
	const handle = first.handle;
	const sessionId = handle.sessionId;
	try {
		const sessionStart = options.observations.length;
		await typeIntoPane(handle.paneId, "Read baseline.txt and report completed with result PROOF-ONE.");
		const firstReport = await waitForReport(handle, {
			observations: options.observations.slice(sessionStart),
			evidence: options.evidence,
			scenario,
			deadlineMs: SCENARIO_LIMIT_SECONDS * 1000,
		});
		if (!firstReport.ok) return { scenario, verdict: "fail", detail: firstReport.detail };

		const before = options.observations.length;
		await stopSession(handle);
		await wait(2000);

		/* The resumed run has its own identity. The report of the run that
		   it resumes cannot settle it. */
		const resumedRunId = `${options.runId}-resumed`;
		const resumed = await resumeSession(options, fixture, pluginDir, sessionId, scenario, resumedRunId);
		if (!resumed) {
			return { scenario, verdict: "fail", detail: "the resumed session did not start" };
		}
		const resumedHandle = resumed;
		try {
			await typeIntoPane(
				resumedHandle.paneId,
				"Read our earlier baseline and report completed with result PROOF-RESUME.",
			);
			/* The proof waits for the report of the resumed run. */
			const deadline = Date.now() + SCENARIO_LIMIT_SECONDS * 1000;
			while (Date.now() < deadline) {
				const found = options.observations
					.slice(before)
					.some(
						(o) =>
							o.source === "report" &&
							String((o.payload as { runId?: string })?.runId ?? "") === resumedRunId,
					);
				if (found) break;
				await wait(1000);
			}
			/* The report of the resumed run must carry the resumed run id. */
			const resumedReports = options.observations
				.slice(before)
				.filter(
					(o) =>
						o.source === "report" && String((o.payload as { runId?: string })?.runId ?? "") === resumedRunId,
				);
			if (resumedReports.length === 0) {
				return {
					scenario,
					verdict: "fail",
					detail: "the resumed run produced no report of its own",
				};
			}
			/* The report of the run that it resumes must not settle it. */
			const earlier = options.observations
				.slice(0, before)
				.filter(
					(o) =>
						o.source === "report" && String((o.payload as { runId?: string })?.runId ?? "") === options.runId,
				);
			const result = await waitForReport(resumedHandle, {
				observations: options.observations.slice(before),
				evidence: options.evidence,
				scenario,
				deadlineMs: SCENARIO_LIMIT_SECONDS * 1000,
			});
			const sessions = options.observations
				.filter((o) => o.source === "session.start")
				.map((o) => (o.payload as { sessionId?: string })?.sessionId);
			return {
				scenario,
				verdict: result.ok ? "pass" : "fail",
				detail: `${result.detail}; ${sessions.length} native session record(s), ids: ${sessions.join(", ")}; the earlier run holds ${earlier.length} report(s)`,
			};
		} finally {
			await stopSession(resumedHandle);
		}
	} catch (error) {
		return { scenario, verdict: "fail", detail: String(error) };
	}
}

/** Resume a Claude session with its native session id. */
async function resumeSession(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
	sessionId: string,
	scenario = "resume",
	runId = options.runId,
): Promise<SessionHandle | null> {
	const listener = await startListener((payload) => recordObservation(options, scenario, payload));
	const env = {
		WEZTERM_PROOF_RUN_ID: runId,
		WEZTERM_PROOF_URL: listener.baseUrl,
		WEZTERM_PROOF_TOKEN: listener.token,
	};
	const result = await runProgram(
		"wezterm",
		[
			"cli",
			"spawn",
			"--cwd",
			fixture,
			"--",
			"claude",
			"--resume",
			sessionId,
			"--plugin-dir",
			pluginDir,
			"--model",
			"haiku",
		],
		undefined,
		env,
	);
	if (result.code !== 0) {
		await listener.close();
		return null;
	}
	const paneId = Number.parseInt(result.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
		await listener.close();
		return null;
	}
	const handle: SessionHandle = { sessionId, runId, paneId, fixture, pluginDir, listener };
	await answerStartupPrompts(paneId);
	return handle;
}

/** Run the settings and usage scenario. */
export async function runSettingsUsage(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "settings-usage";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		await typeIntoPane(handle.paneId, "Read baseline.txt, then report completed with result PROOF-USAGE.");
		await waitForTurnEnd(options, 90_000);
		await wait(5000);
		const usage = options.observations.filter((o) => o.source === "turn.complete");
		const measured = usage.find((o) => (o.payload as { usage?: unknown })?.usage);
		const fields = measured
			? Object.keys((measured.payload as { usage: object }).usage)
					.sort()
					.join(", ")
			: "none";
		const settings = readSettingsSummary();
		return {
			scenario,
			verdict: measured ? "pass" : "unavailable",
			detail: `usage fields: ${measured ? `measured (${fields})` : "missing"}; inherited integration visible: ${settings.visible}`,
		};
	} finally {
		await stopSession(handle);
	}
}

/** The summary of the inherited Claude settings. It holds no secret. */
function readSettingsSummary(): { visible: string } {
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
 * Run the approval scenario.
 *
 * The scenario uses a session-scoped ask rule. It never changes the global
 * settings of the user. The proof answers the prompt in the pane, and it
 * records the native request and the native resolution.
 */
export async function runApproval(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "approval";
	const settings = writeAskSettings(options.args.evidenceDir);
	const started = await startSession(options, fixture, pluginDir, scenario, options.runId, settings);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		await typeIntoPane(
			handle.paneId,
			"Write APPROVED to approval.txt with a shell command, then report completed with result PROOF-APPROVAL.",
		);
		const shown = await waitForPrompt(handle.paneId, 60_000);
		if (!shown) {
			return {
				scenario,
				verdict: "unavailable",
				detail: "the native session raised no permission prompt",
			};
		}
		/* The queued control must refuse while the request is open. */
		const commandId = await sendCommand(
			handle.listener,
			options.runId,
			"Write REFUSED to refused.txt and report completed with result PROOF-REFUSED.",
		);
		await wait(6000);
		const refused = resultsByPhase(handle.listener.results(), "refused").filter((r) => r.id === commandId);

		/* The user approves. The pane owns the answer. */
		await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(handle.paneId), "\r"]);
		await wait(15000);

		/* The native request is the permission decision of the session. The
		   modern permission path does not raise the classic hook, so the
		   decision of the tool check is the request. */
		const checks = options.observations.filter(
			(o) => o.source === "tool.check" && (o.payload as { decision?: string })?.decision === "ask",
		);
		const requests = options.observations.filter((o) => o.source === "approval.requested");
		const raised = checks.length > 0 ? checks : requests;
		const settled = options.observations.filter(
			(o) =>
				o.source === "tool.call.settled" &&
				raised.some(
					(r) => (r.payload as { callId?: string })?.callId === (o.payload as { callId?: string })?.callId,
				),
		);
		const denied = settled.filter((o) => (o.payload as { denied?: boolean })?.denied === true);
		const executed = existsSync(join(fixture, "approval.txt"));
		const detail = `${raised.length} native request(s), ${settled.length} settlement(s), ${denied.length} denial(s); the command ran: ${executed}; the queued control was refused while the request was open: ${refused.length > 0}`;
		if (raised.length === 0) {
			return { scenario, verdict: "fail", detail: `no native permission request was raised; ${detail}` };
		}
		if (settled.length === 0) {
			return { scenario, verdict: "fail", detail: `no native settlement of the request; ${detail}` };
		}
		if (refused.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: `the queued control was not refused while the request was open; ${detail}`,
			};
		}
		return { scenario, verdict: "pass", detail };
	} finally {
		await stopSession(handle);
	}
}

/**
 * Wait until the pane shows a native permission prompt.
 *
 * The function returns true when the prompt is on the screen. It never claims
 * a prompt that the pane does not show.
 */
async function waitForPrompt(paneId: number, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const text = await paneText(paneId, 60);
		if (text.includes("Do you want to proceed") || text.includes("❯ 1. Yes")) return true;
		await wait(1000);
	}
	return false;
}

/**
 * The Claude scenarios that read a task and its input.
 *
 * The scenarios share one reducer, so the rules of a completion report are the
 * same for both backends. Every scenario owns one native session with its own
 * session id.
 */

import { prepareMod, validateMod } from "./claude.ts";
import { runApproval, runResume, runSettingsUsage } from "./claude-lifecycle.ts";
import { runBackground, runRecovery, runStop } from "./claude-lifecycle-2.ts";
import {
	type ClaudeProofOptions,
	sendCommand,
	startSession,
	stopSession,
	typeIntoPane,
	wait,
	waitForReport,
	waitForTurnEnd,
} from "./claude-session.ts";
import { resultsByPhase, type ScenarioOutcome } from "./scenarios.ts";
import { makeFixture, SCENARIO_LIMIT_SECONDS } from "./shared.ts";

/** The result of one proof run. */
export interface ProofOutcome {
	/** The verdict of the run. */
	verdict: "pass" | "fail" | "unavailable";
	/** The result of each scenario. */
	results: ScenarioOutcome[];
}

/**
 * Run the Claude proof.
 *
 * The function runs the scenarios that the request names. Every scenario owns
 * its own native session.
 */
export async function runClaudeProof(options: ClaudeProofOptions): Promise<ProofOutcome> {
	const results: ScenarioOutcome[] = [];
	const evidenceDir = options.args.evidenceDir;
	const pluginDir = prepareMod(evidenceDir);
	const validation = await validateMod(pluginDir);
	options.evidence.raw("claude-plugin-validate.txt", validation.output);
	if (!validation.ok) {
		return {
			verdict: "unavailable",
			results: [
				{
					scenario: "observe",
					verdict: "unavailable",
					detail: "the installed Claude Code refused the proof plugin",
				},
			],
		};
	}

	const fixture = await makeFixture(evidenceDir);
	const scenario = options.args.scenario;
	options.evidence.observe(scenario, "runner.start", { fixture, scenario });

	if (scenario === "observe" || scenario === "all") {
		results.push(await runObserve(options, fixture, pluginDir));
	}
	if (scenario === "queue" || scenario === "all") {
		results.push(await runQueue(options, fixture, pluginDir));
	}
	if (scenario === "direct-input" || scenario === "all") {
		results.push(await runDirectInput(options, fixture, pluginDir));
	}
	if (scenario === "no-report" || scenario === "all") {
		results.push(await runNoReport(options, fixture, pluginDir));
	}
	if (scenario === "resume" || scenario === "all") {
		results.push(await runResume(options, fixture, pluginDir));
	}
	if (scenario === "settings-usage" || scenario === "all") {
		results.push(await runSettingsUsage(options, fixture, pluginDir));
	}
	if (scenario === "approval" || scenario === "all") {
		results.push(await runApproval(options, fixture, pluginDir));
	}
	if (scenario === "background" || scenario === "all") {
		results.push(await runBackground(options, fixture, pluginDir));
	}
	if (scenario === "recovery" || scenario === "all") {
		results.push(await runRecovery(options, fixture, pluginDir));
	}
	if (scenario === "stop" || scenario === "all") {
		results.push(await runStop(options, fixture, pluginDir));
	}

	const verdict: ProofOutcome["verdict"] = results.some((r) => r.verdict === "fail")
		? "fail"
		: results.some((r) => r.verdict === "unavailable")
			? "unavailable"
			: "pass";
	return { verdict, results };
}

/** Run the observe scenario. */
async function runObserve(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "observe";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		const before = options.observations.length;
		await typeIntoPane(
			handle.paneId,
			"Read baseline.txt. Report working. Then report completed with result PROOF-ONE.",
		);
		const result = await waitForReport(handle, {
			observations: options.observations.slice(before),
			evidence: options.evidence,
			scenario,
			deadlineMs: SCENARIO_LIMIT_SECONDS * 1000,
		});
		const own = options.observations.slice(before);
		const report = own.find((o) => o.source === "report");
		const reads = own.filter((o) => o.source === "tool.call.opened");
		const settles = own.filter((o) => o.source === "tool.call.settled");
		const detail = `${result.detail}; ${reads.length} call(s) opened, ${settles.length} settled`;
		if (!result.ok) return { scenario, verdict: "fail", detail };
		if (!report) return { scenario, verdict: "fail", detail: "no report observation reached the listener" };
		return { scenario, verdict: "pass", detail };
	} finally {
		await stopSession(handle);
	}
}

/** Run the queue scenario. */
async function runQueue(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "queue";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		const before = options.observations.length;
		await typeIntoPane(
			handle.paneId,
			"Create started.txt, then run a foreground command that waits 15 seconds, then create first-done.txt. Report completed with result PROOF-QUEUE-BASE.",
		);
		await wait(4000);
		const commandId = await sendCommand(
			handle.listener,
			options.runId,
			"After the current tool finishes, write SECOND to second.txt and report completed with result PROOF-TWO.",
		);
		/* The native submit waits until the session is idle. The proof waits
		   for the turn that carried the first tool to end. */
		await waitForTurnEnd(options, 90_000);
		await wait(20000);
		const accepted = resultsByPhase(handle.listener.results(), "accepted").filter((r) => r.id === commandId);
		if (accepted.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: "the native program never accepted the queued instruction",
			};
		}
		/* The delivery is the native row that carries the queued text. A
		   prompt that the mod submitted does not raise `prompt.submit`, so
		   the row of the transcript is the evidence of the delivery. */
		const delivered = options.observations
			.slice(before)
			.filter(
				(o) =>
					o.source === "instruction.delivered" &&
					typeof o.payload === "object" &&
					o.payload !== null &&
					String((o.payload as { text?: string }).text ?? "").includes("PROOF-TWO"),
			);
		if (delivered.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: "the native program never delivered the queued instruction to a prompt",
			};
		}
		const result = await waitForReport(handle, {
			observations: options.observations.slice(before),
			evidence: options.evidence,
			scenario,
			deadlineMs: SCENARIO_LIMIT_SECONDS * 1000,
		});
		return {
			scenario,
			verdict: result.ok ? "pass" : "fail",
			detail: result.detail,
		};
	} finally {
		await stopSession(handle);
	}
}

/** Run the direct input scenario. */
async function runDirectInput(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "direct-input";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		const before = options.observations.length;
		await typeIntoPane(
			handle.paneId,
			"Run a foreground command that waits 15 seconds, then report completed with result PROOF-DIRECT-BASE.",
		);
		await wait(4000);
		await typeIntoPane(
			handle.paneId,
			"After this tool, write DIRECT to direct.txt and report completed with result PROOF-DIRECT.",
		);
		await waitForTurnEnd(options, 90_000);
		await wait(20000);
		/* The direct input must carry its own report. The report of the
		   earlier cycle cannot settle it. */
		const direct = options.observations
			.slice(before)
			.filter(
				(o) =>
					o.source === "report" &&
					String((o.payload as { result?: string })?.result ?? "") === "PROOF-DIRECT",
			);
		if (direct.length === 0) {
			return {
				scenario,
				verdict: "fail",
				detail: "the direct instruction produced no report of its own",
			};
		}
		const result = await waitForReport(handle, {
			observations: options.observations.slice(before),
			evidence: options.evidence,
			scenario,
			deadlineMs: SCENARIO_LIMIT_SECONDS * 1000,
		});
		const ingress = options.observations.slice(before).filter((o) => o.source === "prompt.submit.ingress");
		if (ingress.length < 2) {
			return {
				scenario,
				verdict: "fail",
				detail: `the native ingress recorded ${ingress.length} prompt(s), so the direct input was not identified`,
			};
		}
		return { scenario, verdict: result.ok ? "pass" : "fail", detail: result.detail };
	} finally {
		await stopSession(handle);
	}
}

/** Run the no-report scenario. */
async function runNoReport(
	options: ClaudeProofOptions,
	fixture: string,
	pluginDir: string,
): Promise<ScenarioOutcome> {
	const scenario = "no-report";
	const started = await startSession(options, fixture, pluginDir, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the session did not start" };
	}
	const handle = started.handle;
	try {
		/* The window of this scenario starts here. The reports of an earlier
		   scenario belong to that scenario, and they say nothing about this
		   one. */
		const before = options.observations.length;
		await typeIntoPane(handle.paneId, "Answer with the word DONE only. Do not call any tool.");
		await wait(25000);
		const own = options.observations.slice(before);
		const reports = own.filter((o) => o.source === "report");
		const turns = own.filter((o) => o.source === "turn.complete");
		if (reports.length > 0) {
			return { scenario, verdict: "fail", detail: "a report arrived although none was requested" };
		}
		if (turns.length === 0) {
			return { scenario, verdict: "unavailable", detail: "the native turn never completed" };
		}
		return {
			scenario,
			verdict: "pass",
			detail: `${turns.length} native turn(s) ended and no report arrived, so the run has no completed verdict`,
		};
	} finally {
		await stopSession(handle);
	}
}

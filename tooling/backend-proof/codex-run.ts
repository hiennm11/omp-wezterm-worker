/**
 * The Codex scenarios that read a task and its input.
 *
 * Every scenario starts its own dedicated app server, creates its own thread,
 * and attaches a real TUI. The observing connection never answers a
 * permission request, so the TUI keeps the answer.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findCodexBinary } from "./codex-binary.ts";
import { attachScenarioTui } from "./codex-dialog.ts";
import { type CodexProofOptions, runScenario, stopHandle } from "./codex-handle.ts";
import { runApproval, runBackground, runRecovery, runSettingsUsage, runStop } from "./codex-lifecycle.ts";
import { deliveredInstructionCount, queueSteerParams, queueTaskText, queueVerdict } from "./codex-queue.ts";
import { runResume } from "./codex-resume.ts";
import { attachTui, recordMessages, startServer, wait } from "./codex-server.ts";
import { answerApprovalDialog, checkTuiPane, recordTuiText } from "./codex-tui.ts";
import type { Verdict } from "./evidence.ts";
import type { ScenarioOutcome } from "./scenarios.ts";
import { makeFixture } from "./shared.ts";

/** The model that the proof uses for a Codex session. */
export const PROOF_CODEX_MODEL = "gpt-6-luna";

/** The result of one proof run. */
export interface ProofOutcome {
	/** The verdict of the run. */
	verdict: "pass" | "fail" | "unavailable";
	/** The result of each scenario. */
	results: ScenarioOutcome[];
}

export async function runCodexProof(options: CodexProofOptions): Promise<ProofOutcome> {
	const results: ScenarioOutcome[] = [];
	const binary = options.binary ?? (await findCodexBinary());
	if (!binary) {
		return {
			verdict: "unavailable",
			results: [
				{
					scenario: "observe",
					verdict: "unavailable",
					detail: "no Codex binary was found on the machine",
				},
			],
		};
	}
	options.evidence.versions({ codexBinary: binary.bin, codexBinaryVersion: binary.version });

	const fixture = await makeFixture(options.args.evidenceDir);
	const scenario = options.args.scenario;

	if (scenario === "observe" || scenario === "all") {
		results.push(await runScenario("observe", options, (own) => runObserve(own, fixture, binary.bin)));
	}
	if (scenario === "queue" || scenario === "all") {
		results.push(await runScenario("queue", options, (own) => runQueue(own, fixture, binary.bin)));
	}
	if (scenario === "no-report" || scenario === "all") {
		results.push(await runScenario("no-report", options, (own) => runNoReport(own, fixture, binary.bin)));
	}
	if (scenario === "resume" || scenario === "all") {
		results.push(await runScenario("resume", options, (own) => runResume(own, fixture, binary.bin)));
	}
	if (scenario === "settings-usage" || scenario === "all") {
		results.push(
			await runScenario("settings-usage", options, (own) => runSettingsUsage(own, fixture, binary.bin)),
		);
	}
	if (scenario === "approval" || scenario === "all") {
		results.push(await runScenario("approval", options, (own) => runApproval(own, fixture, binary.bin)));
	}
	if (scenario === "background" || scenario === "all") {
		results.push(await runScenario("background", options, (own) => runBackground(own, fixture, binary.bin)));
	}
	if (scenario === "recovery" || scenario === "all") {
		results.push(await runScenario("recovery", options, (own) => runRecovery(own, fixture, binary.bin)));
	}
	if (scenario === "stop" || scenario === "all") {
		results.push(await runScenario("stop", options, (own) => runStop(own, fixture, binary.bin)));
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
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "observe";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		const attached = await attachScenarioTui(options, handle, bin);
		if (!attached.pane) {
			return { scenario, verdict: "fail", detail: attached.error ?? "the TUI did not start" };
		}
		const pane = attached.pane;
		await checkTuiPane(options, scenario, pane);

		const turn = await handle.client.request("turn/start", {
			threadId: handle.threadId,
			input: [
				{
					type: "text",
					text: "Read baseline.txt. Report working. Then call the wezterm_worker_report tool with state completed and result PROOF-ONE.",
				},
			],
		});
		if (turn.error) {
			return { scenario, verdict: "fail", detail: turn.error.message };
		}
		/* The scenario `observe` answers every approval dialog of its turn.
		   The scenario `approval` keeps the answer of the person. */
		await answerApprovalDialog(options, scenario, pane, handle.client);
		await wait(20000);
		recordMessages(options, handle.client, scenario);
		await checkTuiPane(options, scenario, pane);
		recordTuiText(options, scenario, pane);

		const report = options.observations.find((o) => o.source === "report");
		const started2 = options.observations.filter((o) => o.source === "codex.turn/started").length;
		const completed = options.observations.filter((o) => o.source === "codex.turn/completed").length;
		const detail = `turns started: ${started2}, completed: ${completed}, report: ${report ? "recorded" : "missing"}`;
		if (!report) return { scenario, verdict: "fail", detail };
		if (completed < 1) return { scenario, verdict: "fail", detail: `${detail}; the turn did not complete` };
		return { scenario, verdict: "pass", detail };
	} finally {
		await stopHandle(handle);
	}
}

/** Run the queue scenario. */
async function runQueue(options: CodexProofOptions, fixture: string, bin: string): Promise<ScenarioOutcome> {
	const scenario = "queue";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		const env = {
			WEZTERM_PROOF_RUN_ID: options.runId,
			WEZTERM_PROOF_URL: handle.listener.baseUrl,
			WEZTERM_PROOF_TOKEN: handle.listener.token,
		};
		const tui = await attachTui(handle, bin, env);
		handle.tuiPaneId = tui.paneId;
		if (tui.paneId === null) {
			return { scenario, verdict: "fail", detail: tui.error ?? "the TUI did not start" };
		}
		await wait(3000);

		/* The turn must stay busy, or the native program has no turn to join.
		   The command of the task waits 20 seconds. */
		const turn = await handle.client.request("turn/start", {
			threadId: handle.threadId,
			input: [{ type: "text", text: queueTaskText() }],
		});
		if (turn.error) {
			return { scenario, verdict: "fail", detail: turn.error.message };
		}
		const turnId = (turn.result as { turn?: { id?: string } } | undefined)?.turn?.id ?? "";
		if (!turnId) {
			return { scenario, verdict: "fail", detail: "the native program started no turn" };
		}
		await wait(6000);

		const clientUserMessageId = randomUUID();
		const steered = await handle.client.request(
			"turn/steer",
			queueSteerParams(handle.threadId, turnId, clientUserMessageId),
		);
		await wait(20000);
		recordMessages(options, handle.client, scenario);

		const delivered = deliveredInstructionCount(options.observations, clientUserMessageId);
		const verdict = queueVerdict({
			accepted: !steered.error,
			refusal: steered.error?.message ?? null,
			delivered,
		});
		return { scenario, verdict: verdict.verdict, detail: verdict.detail };
	} finally {
		await stopHandle(handle);
	}
}

/**
 * The task of the no-report scenario.
 *
 * The task forbids every tool. The model of Codex answers a plain question
 * with the report tool when the tool stands ready. The task must ask for
 * ordinary answer text only, or the scenario proves nothing.
 */
export function noReportTaskText(): string {
	return "Answer with the word DONE only. Do not call any tool.";
}

/**
 * The verdict of the no-report scenario.
 *
 * The scenario passes only when a native turn ended and no report arrived.
 */
export function noReportVerdict(reports: number, completed: number): { verdict: Verdict; detail: string } {
	if (reports > 0) {
		return { verdict: "fail", detail: "a report arrived although none was requested" };
	}
	if (completed === 0) {
		return { verdict: "unavailable", detail: "the native turn never completed" };
	}
	return {
		verdict: "pass",
		detail: `${completed} native turn(s) ended and no report arrived, so the run has no completed verdict`,
	};
}

/** Run the no-report scenario. */
async function runNoReport(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "no-report";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		await handle.client.request("turn/start", {
			threadId: handle.threadId,
			input: [{ type: "text", text: noReportTaskText() }],
		});
		await wait(15000);
		recordMessages(options, handle.client, scenario);
		const reports = options.observations.filter((o) => o.source === "report");
		const completed = options.observations.filter((o) => o.source === "codex.turn/completed").length;
		const verdict = noReportVerdict(reports.length, completed);
		return { scenario, verdict: verdict.verdict, detail: verdict.detail };
	} finally {
		await stopHandle(handle);
	}
}

/** The native config of the machine, for the report. It holds no secret. */
export function readCodexConfigSummary(): string {
	const home = process.env.USERPROFILE ?? "";
	const path = join(home, ".codex", "config.toml");
	try {
		const text = readFileSync(path, "utf8");
		const sections = text.split("\n").filter((line) => line.trim().startsWith("["));
		return sections.map((line) => line.trim()).join(", ");
	} catch {
		return "no config file";
	}
}

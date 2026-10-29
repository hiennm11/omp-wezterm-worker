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

import { runApproval, runBackground, runRecovery, runSettingsUsage, runStop } from "./codex-lifecycle.ts";
import {
	attachTui,
	type CodexProofOptions,
	findCodexBinary,
	recordMessages,
	startServer,
	stopHandle,
	wait,
} from "./codex-server.ts";
import { checkTuiPane, recordTuiText, type TuiPane } from "./codex-tui.ts";
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
		results.push(await runObserve(options, fixture, binary.bin));
	}
	if (scenario === "queue" || scenario === "all") {
		results.push(await runQueue(options, fixture, binary.bin));
	}
	if (scenario === "no-report" || scenario === "all") {
		results.push(await runNoReport(options, fixture, binary.bin));
	}
	if (scenario === "resume" || scenario === "all") {
		results.push(await runResume(options, fixture, binary.bin));
	}
	if (scenario === "settings-usage" || scenario === "all") {
		results.push(await runSettingsUsage(options, fixture, binary.bin));
	}
	if (scenario === "approval" || scenario === "all") {
		results.push(await runApproval(options, fixture, binary.bin));
	}
	if (scenario === "background" || scenario === "all") {
		results.push(await runBackground(options, fixture, binary.bin));
	}
	if (scenario === "recovery" || scenario === "all") {
		results.push(await runRecovery(options, fixture, binary.bin));
	}
	if (scenario === "stop" || scenario === "all") {
		results.push(await runStop(options, fixture, binary.bin));
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
		const env = {
			WEZTERM_PROOF_RUN_ID: options.runId,
			WEZTERM_PROOF_URL: handle.listener.baseUrl,
			WEZTERM_PROOF_TOKEN: handle.listener.token,
		};
		const tui = await attachTui(handle, bin, env);
		handle.paneId = tui.paneId;
		if (tui.paneId === null) {
			return { scenario, verdict: "fail", detail: tui.error ?? "the TUI did not start" };
		}
		const pane: TuiPane = { paneId: tui.paneId, text: "", gone: false };
		await wait(3000);
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
		await wait(20000);
		recordMessages(options, handle.client, scenario);
		await checkTuiPane(options, scenario, pane);
		recordTuiText(options, scenario, pane);

		const report = options.observations.find((o) => o.source === "report");
		const started2 = options.observations.filter((o) => o.source === "codex.turn/started").length;
		const completed = options.observations.filter((o) => o.source === "codex.turn/completed").length;
		const detail = `turns started: ${started2}, completed: ${completed}, report: ${report ? "recorded" : "missing"}`;
		if (!report) return { scenario, verdict: "fail", detail };
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
		handle.paneId = tui.paneId;
		if (tui.paneId === null) {
			return { scenario, verdict: "fail", detail: tui.error ?? "the TUI did not start" };
		}
		await wait(3000);

		const clientUserMessageId = randomUUID();
		const added = await handle.client.request("thread/queue/add", {
			threadId: handle.threadId,
			clientUserMessageId,
			input: [{ type: "text", text: "Write QUEUED to queued.txt" }],
		});
		if (added.error) {
			return { scenario, verdict: "fail", detail: `the queue refused the message: ${added.error.message}` };
		}
		const queued = (added.result as { queuedSubmission?: { id?: string } } | undefined)?.queuedSubmission;
		const repeated = await handle.client.request("thread/queue/add", {
			threadId: handle.threadId,
			clientUserMessageId,
			input: [{ type: "text", text: "Write QUEUED to queued.txt" }],
		});
		const list = await handle.client.request("thread/queue/list", { threadId: handle.threadId });
		const entries = (list.result as { data?: unknown[] } | undefined)?.data ?? [];
		await wait(15000);
		recordMessages(options, handle.client, scenario);

		const delivered = options.observations.filter(
			(o) =>
				o.source === "codex.item/started" &&
				(o.payload as { item?: { clientId?: string } })?.item?.clientId === clientUserMessageId,
		);
		const detail = `queued id: ${queued?.id ?? "none"}; repeated request: ${
			repeated.error ? "refused" : "accepted"
		}; queue entries: ${entries.length}; delivered items: ${delivered.length}`;
		if (!queued?.id) return { scenario, verdict: "fail", detail };
		if (delivered.length === 0) {
			return { scenario, verdict: "fail", detail: `${detail}; the accepted entry never reached a turn` };
		}
		return { scenario, verdict: "pass", detail };
	} finally {
		await stopHandle(handle);
	}
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
			input: [{ type: "text", text: "Answer with the word DONE only." }],
		});
		await wait(15000);
		recordMessages(options, handle.client, scenario);
		const reports = options.observations.filter((o) => o.source === "report");
		const completed = options.observations.filter((o) => o.source === "codex.turn/completed").length;
		if (reports.length > 0) {
			return { scenario, verdict: "fail", detail: "a report arrived although none was requested" };
		}
		if (completed === 0) {
			return { scenario, verdict: "unavailable", detail: "the native turn never completed" };
		}
		return {
			scenario,
			verdict: "pass",
			detail: `${completed} native turn(s) ended and no report arrived, so the run has no completed verdict`,
		};
	} finally {
		await stopHandle(handle);
	}
}

/** Run the resume scenario. */
async function runResume(options: CodexProofOptions, fixture: string, bin: string): Promise<ScenarioOutcome> {
	const scenario = "resume";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	const threadId = handle.threadId;
	try {
		await handle.client.request("turn/start", {
			threadId,
			input: [
				{
					type: "text",
					text: "Read baseline.txt and call the wezterm_worker_report tool with state completed and result PROOF-ONE.",
				},
			],
		});
		await wait(20000);
		recordMessages(options, handle.client, scenario);
		const firstReport = options.observations.find((o) => o.source === "report");
		if (!firstReport) {
			return { scenario, verdict: "fail", detail: "the first turn produced no report" };
		}
		const before = options.observations.length;
		await stopHandle(handle);
		await wait(2000);

		const second = await startServer(options, fixture, bin, scenario);
		if (!second.handle) {
			return { scenario, verdict: "fail", detail: second.error ?? "the second server did not start" };
		}
		const secondHandle = second.handle;
		try {
			const resumed = await secondHandle.client.request("thread/resume", { threadId });
			if (resumed.error) {
				return { scenario, verdict: "fail", detail: resumed.error.message };
			}
			const resumedThread = (resumed.result as { thread?: { id?: string } } | undefined)?.thread;
			if (resumedThread?.id !== threadId) {
				return {
					scenario,
					verdict: "fail",
					detail: `the resumed thread changed its identity: ${String(resumedThread?.id)}`,
				};
			}
			const turns = await secondHandle.client.request("thread/turns/list", { threadId });
			const history = (turns.result as { data?: unknown[] } | undefined)?.data ?? [];
			await secondHandle.client.request("turn/start", {
				threadId,
				input: [
					{
						type: "text",
						text: "Read our earlier baseline and call the wezterm_worker_report tool with state completed and result PROOF-RESUME.",
					},
				],
			});
			await wait(20000);
			recordMessages(options, secondHandle.client, scenario);
			const reports = options.observations.slice(before).filter((o) => o.source === "report");
			const detail = `the thread id stayed ${resumedThread?.id}; stored turns: ${history.length}; new reports: ${reports.length}`;
			if (reports.length === 0) return { scenario, verdict: "fail", detail };
			return { scenario, verdict: "pass", detail };
		} finally {
			await stopHandle(secondHandle);
		}
	} catch (error) {
		return { scenario, verdict: "fail", detail: String(error) };
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

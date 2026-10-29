/**
 * The resume scenario of the Codex proof.
 *
 * The scenario starts two app servers. The first server runs a turn that
 * reports. The second server resumes the thread of the first server and
 * runs a second turn that reports.
 *
 * Both servers need a real TUI, because the TUI of Codex asks the person
 * for the approval of a call of the report server. The scenario answers
 * every dialog of both turns.
 *
 * Every server of the scenario ends on every path. A server that the
 * scenario leaves behind holds a pane and a process on the machine.
 */

import { attachScenarioTui } from "./codex-dialog.ts";
import { type CodexHandle, type CodexProofOptions, stopHandle } from "./codex-handle.ts";
import { recordMessages, startServer, wait } from "./codex-server.ts";
import { answerApprovalDialog, checkTuiPane, recordTuiText } from "./codex-tui.ts";
import type { ScenarioOutcome } from "./scenarios.ts";

/** Run the resume scenario. */
export async function runResume(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "resume";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	const threadId = handle.threadId;
	let firstStopped = false;
	let secondHandle: CodexHandle | null = null;
	try {
		const attached = await attachScenarioTui(options, handle, bin);
		if (!attached.pane) {
			return { scenario, verdict: "fail", detail: attached.error ?? "the TUI did not start" };
		}
		const pane = attached.pane;
		await checkTuiPane(options, scenario, pane);

		await handle.client.request("turn/start", {
			threadId,
			input: [
				{
					type: "text",
					text: "Read baseline.txt and call the wezterm_worker_report tool with state completed and result PROOF-ONE.",
				},
			],
		});
		await answerApprovalDialog(options, scenario, pane, handle.client);
		await wait(20000);
		recordMessages(options, handle.client, scenario);
		await checkTuiPane(options, scenario, pane);
		recordTuiText(options, scenario, pane);
		const firstReport = options.observations.find((o) => o.source === "report");
		if (!firstReport) {
			return { scenario, verdict: "fail", detail: "the first turn produced no report" };
		}
		const before = options.observations.length;
		await stopHandle(handle);
		firstStopped = true;
		await wait(2000);

		const second = await startServer(options, fixture, bin, scenario);
		if (!second.handle) {
			return { scenario, verdict: "fail", detail: second.error ?? "the second server did not start" };
		}
		secondHandle = second.handle;
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

		/* The TUI of the second server shows the thread of the first server. */
		const secondAttached = await attachScenarioTui(options, secondHandle, bin, threadId);
		if (!secondAttached.pane) {
			return { scenario, verdict: "fail", detail: secondAttached.error ?? "the TUI did not start" };
		}
		const secondPane = secondAttached.pane;
		await checkTuiPane(options, scenario, secondPane);

		await secondHandle.client.request("turn/start", {
			threadId,
			input: [
				{
					type: "text",
					text: "Read our earlier baseline and call the wezterm_worker_report tool with state completed and result PROOF-RESUME.",
				},
			],
		});
		await answerApprovalDialog(options, scenario, secondPane, secondHandle.client);
		await wait(20000);
		recordMessages(options, secondHandle.client, scenario);
		await checkTuiPane(options, scenario, secondPane);
		recordTuiText(options, scenario, secondPane);
		const reports = options.observations.slice(before).filter((o) => o.source === "report");
		const detail = `the thread id stayed ${resumedThread?.id}; stored turns: ${history.length}; new reports: ${reports.length}`;
		if (reports.length === 0) return { scenario, verdict: "fail", detail };
		return { scenario, verdict: "pass", detail };
	} catch (error) {
		return { scenario, verdict: "fail", detail: String(error) };
	} finally {
		if (!firstStopped) await stopHandle(handle);
		if (secondHandle) await stopHandle(secondHandle);
	}
}

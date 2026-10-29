/**
 * The pane evidence of the Codex proof.
 *
 * The proof reads the text of the pane of the TUI. The text shows what the
 * TUI did before the pane ended. A pane that ended gives the observation
 * `tui.exited`. A pane that is gone gives the observation `tui.pane-gone`
 * with the pane list of the machine.
 */

import { type CodexProofOptions, wait } from "./codex-server.ts";
import { runProgram } from "./shared.ts";

/**
 * The text that the approval dialog of the report server carries.
 *
 * The TUI shows this text when it asks the person for the approval of a
 * call of the tool `wezterm_worker_report`.
 */
const APPROVAL_DIALOG = "Allow the wezterm_worker_proof MCP server to run tool";

/** The seconds that the proof waits for the approval dialog. */
const APPROVAL_LIMIT_SECONDS = 30;

/** The state of the pane of the TUI. */
export interface TuiPane {
	/** The id of the pane. */
	paneId: number;
	/** The last text that the proof read from the pane. */
	text: string;
	/** The proof recorded that the pane is gone. */
	gone: boolean;
}

/**
 * The pane ids that WezTerm holds.
 *
 * The function returns an empty list when the pane list cannot be read.
 */
export async function listPanes(): Promise<number[]> {
	const result = await runProgram("wezterm", ["cli", "list", "--format", "json"]);
	try {
		const panes = JSON.parse(result.stdout) as Array<{ pane_id: number }>;
		return panes.map((pane) => pane.pane_id);
	} catch {
		return [];
	}
}

/** Read the text of a pane, or report that the pane holds no text. */
async function readPaneText(paneId: number): Promise<string | null> {
	const result = await runProgram("wezterm", ["cli", "get-text", "--pane-id", String(paneId)]);
	if (result.code !== 0) return null;
	return result.stdout;
}

/**
 * Check that the text of a pane shows the approval dialog of the report server.
 *
 * The function is pure. It looks for the text of the dialog and nothing else.
 */
export function approvalDialogShown(text: string): boolean {
	return text.includes(APPROVAL_DIALOG);
}

/**
 * Answer the approval dialog of the report server.
 *
 * The function reads the text of the pane every second. It stops when the
 * dialog shows or when the limit of 30 seconds passes. The Enter key selects
 * the first option of the dialog, and that option allows the call. The
 * function records the observation `tui.approval-answered` with the text that
 * showed the dialog.
 *
 * Only the scenario `observe` calls this function. The other scenarios keep
 * the answer of the person.
 */
export async function answerApprovalDialog(
	options: CodexProofOptions,
	scenario: string,
	pane: TuiPane,
): Promise<boolean> {
	for (let second = 0; second < APPROVAL_LIMIT_SECONDS; second += 1) {
		const text = await readPaneText(pane.paneId);
		if (text === null) return false;
		pane.text = text;
		if (!approvalDialogShown(text)) {
			await wait(1000);
			continue;
		}
		await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(pane.paneId), "\r"]);
		options.evidence.observe(scenario, "tui.approval-answered", text);
		return true;
	}
	return false;
}

/**
 * Check the pane of the TUI.
 *
 * The check reads the text of the pane while the pane exists. A pane that
 * ended gives the observation `tui.exited` with the last text that the
 * proof read and the observation `tui.pane-gone` with the pane list. The
 * check records the two observations only one time.
 */
export async function checkTuiPane(
	options: CodexProofOptions,
	scenario: string,
	pane: TuiPane,
): Promise<void> {
	const text = await readPaneText(pane.paneId);
	if (text !== null) {
		pane.text = text;
		return;
	}
	if (pane.gone) return;
	pane.gone = true;
	const last = pane.text.trim() ? pane.text : "the pane held no readable text";
	options.evidence.observe(scenario, "tui.exited", last);
	const panes = await listPanes();
	options.evidence.observe(scenario, "tui.pane-gone", { paneId: pane.paneId, panes });
}

/**
 * Record the text of the pane of the TUI.
 *
 * The scenario calls the function before it closes the pane, so the text
 * shows the last state of the TUI.
 */
export function recordTuiText(options: CodexProofOptions, scenario: string, pane: TuiPane): void {
	options.evidence.observe(scenario, "tui.text", pane.text);
}

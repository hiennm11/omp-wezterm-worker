/**
 * The pane evidence of the Codex proof.
 *
 * The proof reads the text of the pane of the TUI. The text shows what the
 * TUI did before the pane ended. A pane that ended gives the observation
 * `tui.exited`. A pane that is gone gives the observation `tui.pane-gone`
 * with the pane list of the machine.
 */

import type { CodexProofOptions } from "./codex-server.ts";
import { runProgram } from "./shared.ts";

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

/**
 * The pane evidence of the Codex proof.
 *
 * The proof reads the text of the pane of the TUI. The text shows what the
 * TUI did before the pane ended. A pane that ended gives the observation
 * `tui.exited`. A pane that is gone gives the observation `tui.pane-gone`
 * with the pane list of the machine.
 *
 * The TUI of Codex asks the person for the approval of a call of the report
 * server and for the approval of a shell command. The proof answers both
 * dialogs. Only the scenario `approval` keeps the answer of the person.
 */

import type { AppServerClient } from "./codex.ts";
import type { CodexProofOptions } from "./codex-handle.ts";
import { recordMessages, wait } from "./codex-server.ts";
import { runProgram } from "./shared.ts";

/**
 * The text that the approval dialog of the report server carries.
 *
 * The TUI shows this text when it asks the person for the approval of a
 * call of the tool `wezterm_worker_report`.
 */
const MCP_DIALOG = "Allow the wezterm_worker_proof MCP server to run tool";

/**
 * The text that the approval dialog of a shell command carries.
 *
 * The TUI shows this text when it asks the person for the approval of a
 * command that the model wants to run.
 */
const COMMAND_DIALOG = "Would you like to run the following command?";

/**
 * The bullet that the first option of a dialog carries.
 *
 * The options of a dialog start at the bottom of the dialog. The text
 * between the marker of the dialog and that bullet names the call or the
 * command of the dialog.
 */
const OPTION_BULLET = "›";

/** The seconds that the proof waits for the approval dialogs of a turn. */
const APPROVAL_LIMIT_SECONDS = 60;

/** The milliseconds that the proof waits after it answered a dialog. */
const SETTLE_MILLISECONDS = 3000;

/** The milliseconds that the proof waits between two reads of the pane. */
const READ_INTERVAL_MILLISECONDS = 1000;

/** The kind of a dialog that the Codex TUI shows. */
export type DialogKind = "mcp" | "command";

/** The text that each kind of dialog carries. */
const DIALOG_MARKERS: Record<DialogKind, string> = {
	mcp: MCP_DIALOG,
	command: COMMAND_DIALOG,
};

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
	return text.includes(MCP_DIALOG);
}

/**
 * Check that the text of a pane shows the approval dialog of a shell command.
 *
 * The function is pure. It looks for the text of the dialog and nothing else.
 */
export function commandDialogShown(text: string): boolean {
	return text.includes(COMMAND_DIALOG);
}

/**
 * The kind of the dialog that the text of a pane shows.
 *
 * The function is pure. When both dialogs show, it returns the dialog that
 * appears last in the text, because the newest dialog of the TUI sits at
 * the bottom of the pane.
 */
export function dialogKind(text: string): DialogKind | null {
	const mcp = text.lastIndexOf(MCP_DIALOG);
	const command = text.lastIndexOf(COMMAND_DIALOG);
	if (mcp < 0 && command < 0) return null;
	if (mcp < 0) return "command";
	if (command < 0) return "mcp";
	return mcp > command ? "mcp" : "command";
}

/**
 * The text of the dialog of a kind in the text of a pane.
 *
 * The function is pure. It returns the text between the marker of the dialog
 * and the options of that dialog. That text names the call or the command
 * of the dialog, so two dialogs of the same kind have two different bodies.
 */
function dialogBody(text: string, marker: string): string {
	const index = text.lastIndexOf(marker);
	if (index < 0) return "";
	const rest = text.slice(index);
	const bullet = rest.indexOf(OPTION_BULLET);
	return (bullet < 0 ? rest : rest.slice(0, bullet)).trim();
}

/**
 * The number of the dialogs of a kind that the text of a pane shows.
 *
 * The TUI redraws the pane. The text of the pane then holds one copy of a
 * dialog, and a new dialog adds a copy.
 */
function countDialogs(text: string, marker: string): number {
	let count = 0;
	let index = text.indexOf(marker);
	while (index >= 0) {
		count += 1;
		index = text.indexOf(marker, index + marker.length);
	}
	return count;
}

/** The state of the answers of one kind of dialog. */
interface DialogState {
	/** The body of the dialog of that kind that the proof answered last. */
	body: string;
	/** The number of the dialogs of that kind that the pane showed at that answer. */
	count: number;
	/** The text of the last dialog of that kind left the pane. */
	gone: boolean;
}

/**
 * Wait until the text of a dialog leaves the pane.
 *
 * The function reads the pane every second until the dialog is gone or
 * until three seconds pass. The function returns the last text of the pane.
 */
async function waitForDialogGone(pane: TuiPane, marker: string): Promise<string> {
	const deadline = Date.now() + SETTLE_MILLISECONDS;
	while (Date.now() < deadline) {
		await wait(READ_INTERVAL_MILLISECONDS);
		const text = await readPaneText(pane.paneId);
		if (text === null) return pane.text;
		pane.text = text;
		if (!text.includes(marker)) return text;
	}
	return pane.text;
}

/**
 * Answer every approval dialog of a turn.
 *
 * The function reads the text of the pane every second. When a dialog shows,
 * the function sends the Enter key to the pane, and the first option of the
 * dialog allows the call. The function records the observation
 * `tui.approval-answered` with the kind of the dialog and the text of the
 * pane.
 *
 * A turn can hold two dialogs, so the function answers every dialog of the
 * turn. It never answers the same dialog twice. After an answer it waits
 * until the text of that dialog is gone or until three seconds pass.
 *
 * The function stops when the turn of the scenario ends or after 60
 * seconds. It returns true when it answered at least one dialog.
 */
export async function answerApprovalDialog(
	options: CodexProofOptions,
	scenario: string,
	pane: TuiPane,
	client: AppServerClient,
): Promise<boolean> {
	const deadline = Date.now() + APPROVAL_LIMIT_SECONDS * 1000;
	const completedBefore = options.observations.filter((o) => o.source === "codex.turn/completed").length;
	const states: Record<DialogKind, DialogState> = {
		mcp: { body: "", count: 0, gone: false },
		command: { body: "", count: 0, gone: false },
	};
	let answeredOne = false;

	while (Date.now() < deadline) {
		const text = await readPaneText(pane.paneId);
		if (text === null) return answeredOne;
		pane.text = text;
		recordMessages(options, client, scenario);
		const completed = options.observations.filter((o) => o.source === "codex.turn/completed").length;
		if (completed > completedBefore) return answeredOne;

		for (const kind of ["mcp", "command"] as DialogKind[]) {
			if (!text.includes(DIALOG_MARKERS[kind])) states[kind].gone = true;
		}
		const kind = dialogKind(text);
		if (kind !== null) {
			const state = states[kind];
			const marker = DIALOG_MARKERS[kind];
			const shown = countDialogs(text, marker);
			const body = dialogBody(text, marker);
			/* The pane shows a new dialog when the body of it differs, when
			   the pane holds more copies of it, or when the last one went
			   away and came back. */
			const isNew = body !== "" && (body !== state.body || shown > state.count || state.gone);
			if (isNew) {
				await runProgram("wezterm", [
					"cli",
					"send-text",
					"--no-paste",
					"--pane-id",
					String(pane.paneId),
					"\r",
				]);
				options.evidence.observe(scenario, "tui.approval-answered", { kind, text });
				state.body = body;
				state.count = shown;
				state.gone = false;
				answeredOne = true;
				const settled = await waitForDialogGone(pane, marker);
				if (!settled.includes(marker)) state.gone = true;
			}
		}
		await wait(READ_INTERVAL_MILLISECONDS);
	}
	return answeredOne;
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

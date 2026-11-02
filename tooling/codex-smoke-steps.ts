/**
 * The steps of the Codex smoke test.
 *
 * Every step prints one line. A step that passed prints `PASS`. A step that
 * failed prints `FAIL` with its evidence. A step that could not run prints
 * `NOT RUN` with its reason.
 *
 * The module holds the decisions of the smoke test. The order of the events
 * of a steering instruction is one such decision, so the function that reads
 * it is pure and a test checks it.
 */

import type { ProcessRow } from "./codex-smoke-machine.ts";

/** The result of one step. */
export type StepOutcome = "pass" | "fail" | "not-run";

/** One line of the report of the smoke test. */
export interface StepLine {
	/** The verdict of the step. */
	outcome: StepOutcome;
	/** The name of the check of the step. */
	what: string;
	/** The evidence of the step, or the reason that it could not run. */
	evidence: string;
}

/**
 * The verdict of the run of the smoke test.
 *
 * The script gives 0 when every step passed. The script also gives 0 when
 * every step that could not run names a test file of the repository and
 * that file exists. A step that failed always gives 1.
 */
export interface RunVerdict {
	/** The exit code of the script. */
	code: number;
	/** The reason of the exit code, when the code is not 0. */
	reason: string | null;
}

/**
 * Decide the exit code of the smoke test.
 *
 * The function reads the lines of the report and the files that the tests
 * cover. A line that could not run must name a test file. The file must
 * exist, because the criterion closes with that test.
 *
 * The function is pure, so a test checks it without a pane.
 */
export function runVerdict(lines: StepLine[], testFileExists: (path: string) => boolean): RunVerdict {
	const failed = lines.filter((line) => line.outcome === "fail");
	if (failed.length > 0) {
		const names = failed.map((line) => line.what).join(", ");
		return { code: 1, reason: `${failed.length} step(s) failed: ${names}` };
	}
	const notRun = lines.filter((line) => line.outcome === "not-run");
	for (const line of notRun) {
		const named = line.evidence.match(/tests\/[a-z0-9.-]+\.test\.ts/);
		if (!named) {
			return {
				code: 1,
				reason: `the step "${line.what}" could not run and names no test file`,
			};
		}
		if (!testFileExists(named[0])) {
			return {
				code: 1,
				reason: `the step "${line.what}" could not run and the test file ${named[0]} is gone`,
			};
		}
	}
	return { code: 0, reason: null };
}

/** The name of the check that a step proves. */
export const STEP_NAMES = {
	spawnAndCancel:
		"a Codex spawn opens an app server pane and a TUI pane, the worker reports SMOKE-OK, and a cancel ends the worker",
	nativeConfig: "the config and the credentials of Codex keep their hash, and the TUI names no model",
	toolListRefused: "a spawn with a tool list is refused before the launch",
	mcpServers: "the app server lists the report server and the servers of the user",
	steerOrder: "the events of a steering instruction arrive in the order of the contract",
	directInput: "a task typed into the TUI starts a new cycle of the run",
	executionEvidence: "the ledger holds a row for a shell command of the worker",
	permissionRequest:
		"the status tool lists one permission request, and a second poll creates no second event",
	daemonAndRollout:
		"the daemon of the user survives, and the rollout file of a cancelled thread stays on the disk",
	unknownBackend: "a spawn with an unknown backend is refused before the launch",
	recovery: "a second session takes a running Codex worker over and receives its report",
	resume: "a finished Codex worker resumes in its own thread and reports again",
} as const;

/**
 * The instruction that every task of the smoke test gives.
 *
 * A Codex worker that resumes a thread can say that the report tool does not
 * exist. The native host calls the tool under the name
 * `mcp__wezterm_worker_report__wezterm_worker_report`, so a search for the
 * plain name finds nothing. The task tells the worker to find the tool whose
 * name ends with `wezterm_worker_report`, and the call works with that
 * wording.
 */
export const REPORT_INSTRUCTION =
	"Find the tool whose name ends with wezterm_worker_report, with ALL_TOOLS. " +
	"Then call it. Report the state completed and the result SMOKE-OK.";

/**
 * The order of the events of a steering instruction.
 *
 * The request `turn/steer` of Codex joins the instruction to the turn that
 * already runs, so the instruction opens no new turn. The event
 * `turn/started` of that turn comes first, because the turn starts before
 * the owner sends the instruction. The answer of the steer tool comes next,
 * because the tool answers when the server accepted the instruction. The
 * delivery of the instruction comes next, because the model receives it in
 * the running turn. The report of the cycle comes last, because the worker
 * sends it when it ends its work.
 *
 * ADR 0012 states the rule: the server joins the instruction to the running
 * turn.
 */
export const STEER_EVENT_ORDER = [
	"turn/started",
	"steer answer",
	"instruction delivered",
	"first report",
] as const;

/** One kind of event of a steering instruction. */
export type SteerEventKind = (typeof STEER_EVENT_ORDER)[number];

/**
 * The order of the events that a run observed.
 *
 * The function reads the times of the events and gives the order back. An
 * event that never arrived is missing. The function is pure, so a test
 * checks it without a pane.
 */
export function steerEventOrder(times: Partial<Record<SteerEventKind, number>>): {
	order: SteerEventKind[];
	missing: SteerEventKind[];
	ordered: boolean;
} {
	const order: SteerEventKind[] = [];
	const missing: SteerEventKind[] = [];
	for (const kind of STEER_EVENT_ORDER) {
		const at = times[kind];
		if (at === undefined) missing.push(kind);
		else order.push(kind);
	}
	let ordered = true;
	for (let index = 1; index < order.length; index += 1) {
		const previous = times[order[index - 1]];
		const current = times[order[index]];
		if (previous === undefined || current === undefined) continue;
		if (current < previous) ordered = false;
	}
	return { order, missing, ordered };
}

/**
 * The order of the events of a steering instruction as one text.
 *
 * The text names every event of the contract and its time. A missing event
 * names itself as missing.
 */
export function steerOrderText(times: Partial<Record<SteerEventKind, number>>): string {
	const { order, missing } = steerEventOrder(times);
	const parts: string[] = [];
	for (const kind of STEER_EVENT_ORDER) {
		const at = times[kind];
		if (at === undefined) {
			parts.push(`${kind}: missing`);
			continue;
		}
		parts.push(`${kind}: ${at}`);
	}
	const sequence = order.join(" -> ");
	return `${parts.join(", ")}; order: ${sequence}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`;
}

/**
 * The ids of the shared daemon of the user before and after the smoke test.
 *
 * The daemon must survive the run. The function compares the two lists.
 */
export function daemonSurvived(before: number[], after: number[]): boolean {
	if (before.length === 0) return false;
	for (const pid of before) if (!after.includes(pid)) return false;
	return true;
}

/**
 * The panes of the user that survived the smoke test.
 *
 * Every pane of the user before the run must still exist after the run.
 */
export function userPanesSurvived(before: number[], after: number[]): boolean {
	for (const pane of before) if (!after.includes(pane)) return false;
	return true;
}

/**
 * The command line of a TUI names no model.
 *
 * The extension passes a model to the TUI only when the spawn names one.
 * The smoke spawn names none, so the command line holds no `-m`.
 */
export function tuiCommandLineNamesNoModel(row: ProcessRow): boolean {
	return !/(^|\s)-m(\s|=|$)/.test(row.commandLine);
}

/**
 * The state of a worker that the status tool shows.
 *
 * The function reads the text of the status tool and finds the state of one
 * worker. A worker that the text does not name gives null.
 */
export function workerStateOf(statusText: string, workerId: string): string | null {
	const lines = statusText.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`${workerId}  `));
	if (start < 0) return null;
	const state = lines[start].slice(workerId.length + 2).trim();
	return state.length > 0 ? state : null;
}

/**
 * The number of reports that the status of a worker shows.
 *
 * The native line of the status holds the number of reports of a run.
 */
export function reportCountOf(statusText: string, workerId: string): number | null {
	const lines = statusText.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`${workerId}  `));
	if (start < 0) return null;
	for (let index = start; index < lines.length; index += 1) {
		const match = /(\d+) report\(s\)/.exec(lines[index]);
		if (match) return Number.parseInt(match[1], 10);
	}
	return null;
}

/**
 * The number of cycles that the status of a worker shows.
 *
 * The status tool shows the number of cycles of a run on the line `turns`.
 * A worker that finished shows the same count on the line `native`.
 */
export function cycleCountOf(statusText: string, workerId: string): number | null {
	const lines = statusText.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`${workerId}  `));
	if (start < 0) return null;
	for (let index = start; index < lines.length; index += 1) {
		const turns = /^\s*turns\s*:\s*(\d+)/.exec(lines[index]);
		if (turns) return Number.parseInt(turns[1], 10);
	}
	for (let index = start; index < lines.length; index += 1) {
		const cycles = /(\d+) cycle\(s\)/.exec(lines[index]);
		if (cycles) return Number.parseInt(cycles[1], 10);
	}
	return null;
}

/**
 * The number of workers that the status tool lists.
 *
 * The status tool prints one block for every worker. The function counts
 * the blocks, so a caller can compare the number before and after a call.
 */
export function workerCountOf(statusText: string): number {
	let count = 0;
	for (const line of statusText.split("\n")) {
		if (/^wz-[0-9a-z]+-[0-9a-z]+\s{2}\S+/.test(line)) count += 1;
	}
	return count;
}

/**
 * The number of events with a condition that the status tool lists.
 *
 * The status tool names every event that waits for the owner with its id and
 * its condition. The function counts the events of one condition.
 */
export function eventCountOf(statusText: string, condition: string): number {
	let count = 0;
	for (const line of statusText.split("\n")) {
		if (!line.includes(condition)) continue;
		if (!/^\s+\S+\s+\S+\s+\(worker /.test(line)) continue;
		count += 1;
	}
	return count;
}

/**
 * The text that the TUI shows for a Codex screen.
 *
 * The TUI of Codex names the program in its header. The function looks for
 * that name and for the composer of the screen.
 */
export function showsCodexScreen(text: string): boolean {
	const lower = text.toLowerCase();
	return lower.includes("codex");
}

/**
 * The text that the TUI shows for the dialog of a shell command.
 *
 * The dialog asks the person for the approval of a command. The TUI wraps
 * its text to the width of the pane, so the question can be split over
 * two lines. The function looks for the first option of the dialog, which
 * the TUI keeps on one line.
 */
export function showsCommandDialog(text: string): boolean {
	if (text.includes("Would you like to run the following command?")) return true;
	return text.includes("Yes, proceed");
}

/**
 * The text of a rollout file that names a thread.
 *
 * The file holds the id of its thread in its first line. The function reads
 * the id, or null when the file names no thread.
 */
export function rolloutThreadId(text: string): string | null {
	try {
		const parsed = JSON.parse(text.split("\n")[0]) as { payload?: { id?: unknown } };
		const id = parsed.payload?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

/**
 * The decisions of the Claude smoke test.
 *
 * Every decision here is a pure function of its arguments. A test checks
 * the decisions without a pane and without a program.
 *
 * The module holds the names of the checks of the steps, the reading of the
 * report of a run, the reading of the command line of a process, and the
 * comparison of the home folder of Claude Code.
 */

import type { StepLine } from "./claude-smoke-shared.ts";

/** The name of the check that a step proves. */
export const STEP_NAMES = {
	spawnAndReport: "a Claude spawn starts a worker, and the worker reports SMOKE-OK",
	reportBindsToCycle: "the report of the run binds to the cycle that produced it",
	usage: "the finished native worker keeps its measured usage",
	toolsRefused: "a spawn with a tool list is refused before the launch",
	unknownBackend: "a spawn with an unknown backend is refused before the launch",
	defaultModel: "a spawn with no model names no model in the command line of the process",
	resume: "a finished Claude worker resumes in its native session and reports RESUME-OK",
	steer: "a steering instruction reaches the worker, and the worker reports STEER-OK",
	cancel: "a cancel ends the worker, its pane, and its process, and spares the other workers",
	externalHistory:
		"the session folder of the cancelled worker stays, and the settings of Claude Code keep their hash",
} as const;

/**
 * The report that the run of a worker wrote.
 *
 * The report file holds one line per report. The function reads the line
 * that belongs to the given run.
 */
export interface ReportLine {
	/** The id of the run that sent the report. */
	runId: string | null;
	/** The id of the cycle that the report binds to. */
	cycleId: string | null;
	/** The state that the report declares. */
	state: string | null;
	/** The result that the report carries. */
	result: string | null;
}

/**
 * The report of one run, read from the text of the report file.
 *
 * The function reads the lines of the file and skips a line that is not
 * valid JSON. It gives null when the file holds no report of the run.
 */
export function reportOf(text: string, runId: string): ReportLine | null {
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.runId !== runId) continue;
		return {
			runId: typeof parsed.runId === "string" ? parsed.runId : null,
			cycleId: typeof parsed.cycleId === "string" ? parsed.cycleId : null,
			state: typeof parsed.state === "string" ? parsed.state : null,
			result: typeof parsed.result === "string" ? parsed.result : null,
		};
	}
	return null;
}

/**
 * The verdict that the report of a run gets.
 *
 * The report must name a cycle, and the cycle must be the cycle that the
 * run delivered last. A report with no cycle binds to no cycle, so the
 * supervisor must not finish the run with it.
 */
export function reportBindsToCycle(reportCycleId: string | null, lastTurnId: string | null): boolean {
	if (reportCycleId === null || reportCycleId.length === 0) return false;
	if (lastTurnId === null || lastTurnId.length === 0) return false;
	return reportCycleId === lastTurnId;
}

/**
 * The id of the last turn that a bridge log names.
 *
 * The bridge log holds one line per observation of the run. The observation
 * of a turn start names the id of that turn. The function reads the last
 * such id, because the last turn is the cycle that the run delivered last.
 */
export function lastTurnIdOf(bridgeText: string): string | null {
	let last: string | null = null;
	for (const raw of bridgeText.split("\n")) {
		if (!raw.trim()) continue;
		let parsed: { source?: unknown; payload?: unknown };
		try {
			parsed = JSON.parse(raw) as typeof parsed;
		} catch {
			continue;
		}
		if (parsed.source !== "turn.start") continue;
		const payload = parsed.payload as { turnId?: unknown } | null;
		const turnId = payload?.turnId;
		if (typeof turnId === "string" && turnId.length > 0) last = turnId;
	}
	return last;
}

/**
 * The command line of a process names no model.
 *
 * The extension passes a model to the program of Claude Code only when the
 * spawn names one. The smoke spawn names none, so the command line holds no
 * `--model`.
 */
export function commandLineNamesNoModel(commandLine: string): boolean {
	return !/(^|\s)--model(\s|=|$)/.test(commandLine);
}

/**
 * The difference between the home folder of Claude Code before and after a
 * run.
 */
export interface HomeDifference {
	/** The settings of Claude Code changed. */
	settingsChanged: boolean;
	/** The entries of the folder of the sessions that are gone. */
	missingEntries: string[];
	/** The entries of the folder of the sessions that are new. */
	addedEntries: string[];
}

/**
 * Compare the home folder of Claude Code before and after a run.
 *
 * The function reads no file. The caller gives the hash of the settings
 * before the run and the hash after it, and the entries of the folder of the
 * sessions before the run and after it.
 *
 * A new entry is not a failure, because Claude Code writes its own session
 * folder into that folder. A missing entry is a failure, and a change of
 * the settings is a failure.
 */
export function homeDifference(
	settingsHashBefore: string,
	settingsHashAfter: string,
	entriesBefore: string[],
	entriesAfter: string[],
): HomeDifference {
	const before = new Set(entriesBefore);
	const after = new Set(entriesAfter);
	return {
		settingsChanged: settingsHashBefore !== settingsHashAfter,
		missingEntries: entriesBefore.filter((entry) => !after.has(entry)),
		addedEntries: entriesAfter.filter((entry) => !before.has(entry)),
	};
}

/**
 * The descendants of a set of processes.
 *
 * A worker of Claude Code starts a helper, and the helper starts the shell
 * of every command. A cancelled worker leaves that shell behind, and the
 * shell holds the folder of the repository. The function finds every
 * process that descends from one of the given roots, at any depth.
 *
 * The function is pure, so a test checks it without a process.
 */
export function descendantsOf(
	rows: Array<{ processId: number; parentProcessId: number | null }>,
	roots: Iterable<number>,
): number[] {
	const parents = new Map<number, number | null>();
	for (const row of rows) parents.set(row.processId, row.parentProcessId);
	const found = new Set<number>();
	const pending = [...roots];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) continue;
		for (const row of rows) {
			if (row.parentProcessId !== current) continue;
			if (found.has(row.processId)) continue;
			found.add(row.processId);
			pending.push(row.processId);
		}
	}
	return [...found];
}

/**
 * The verdict of the run of the smoke test.
 *
 * The script gives 0 only when every line is a pass. A line that could not
 * run gives 1, because the script did not observe the behavior.
 */
export function runVerdict(lines: StepLine[]): { code: number; reason: string | null } {
	const failed = lines.filter((line) => line.outcome === "fail");
	if (failed.length > 0) {
		return {
			code: 1,
			reason: `${failed.length} step(s) failed: ${failed.map((line) => line.what).join(", ")}`,
		};
	}
	const notRun = lines.filter((line) => line.outcome === "not-run");
	if (notRun.length > 0) {
		return {
			code: 1,
			reason: `${notRun.length} step(s) could not run: ${notRun.map((line) => line.what).join(", ")}`,
		};
	}
	return { code: 0, reason: null };
}

/**
 * The instruction that every task of the smoke test gives.
 *
 * The task names the tool that the worker must call, because the native
 * host calls the tool under its MCP name. A search for the plain name finds
 * nothing, so the task names the tool whose name ends with the plain name.
 */
export const REPORT_INSTRUCTION =
	"Read baseline.txt. Then call the tool whose name ends with wezterm_worker_report. " +
	"Report the state completed and the result SMOKE-OK.";

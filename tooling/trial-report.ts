/**
 * The Windows trial report.
 *
 * The renderer has no I/O, so a unit test can check the text it produces.
 * The runner in `tooling/trial.ts` collects the facts and calls this module.
 */

import { combineReports, formatUsage, type UsageReport } from "../extensions/lib/usage.ts";
import { redactHome, replaceRoots, reportPath, type TrialRoot } from "./trial-paths.ts";

/** One check that a scenario ran. */
export interface TrialCheck {
	name: string;
	pass: boolean;
	detail: string;
}

/** The result of one scenario. */
export interface ScenarioResult {
	/** The name of the scenario, for example "Survey". */
	name: string;
	/** The exact task text that was sent to the worker. */
	task: string;
	/** The id of the worker, or null when the spawn was refused or failed. */
	workerId: string | null;
	/** The final job status, or "not started". */
	status: string;
	/** The time that the worker ran, in milliseconds. */
	workerMs: number | null;
	/** The time from the spawn call to the last check, in milliseconds. */
	wallMs: number;
	/** The measured usage of the worker. */
	usage: UsageReport;
	/** The path of the worker transcript, or null. */
	transcript: string | null;
	/** The checks that this scenario ran. */
	checks: TrialCheck[];
}

/** The facts of one trial run. */
export interface TrialRun {
	/** The time of the start of the run, in ISO format. */
	startedAt: string;
	/** The programs and the state directory of the run. */
	environment: { os: string; node: string; omp: string; wezterm: string };
	/** The model that every worker used. */
	model: string;
	/** The directory that holds the registry and the transcripts. */
	stateDir: string;
	/** The paths of this machine that must not appear in the report. */
	roots: TrialRoot[];
	/** The scenarios of the run, in the order they ran. */
	scenarios: ScenarioResult[];
}

/** The time of a duration in milliseconds, in seconds. */
function seconds(ms: number | null): string {
	if (ms === null) return "-";
	return `${Math.round(ms / 1000)} s`;
}

/** The number of the checks that passed, and the number of checks. */
function checkCounts(scenario: ScenarioResult): string {
	const passed = scenario.checks.filter((check) => check.pass).length;
	return `${passed}/${scenario.checks.length}`;
}

/**
 * The text of a check as one line.
 *
 * A check detail that holds a line break would split the bullet of the
 * report, so the line breaks become spaces.
 */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The sentences that explain the numbers of the report. */
const NOTES = [
	"The numbers come from the worker transcripts.",
	"The value unknown means that the transcript holds no usage data.",
	"The script does not estimate a value.",
	"The main session is not counted.",
];

/** The report of one trial run, as markdown. */
export function renderTrialReport(run: TrialRun): string {
	// A worker writes paths of its own into its answer. Every path of this
	// machine is replaced before the report is written, so the report holds
	// no name of the user account.
	const clean = (text: string): string => redactHome(replaceRoots(text, run.roots));
	const lines: string[] = [];
	lines.push("# Windows trial");
	lines.push("");
	lines.push(`Run started at ${run.startedAt}. Model: ${run.model}.`);
	lines.push("");
	lines.push("## Environment");
	lines.push("");
	lines.push("| Item | Value |");
	lines.push("|---|---|");
	lines.push(`| OS | ${run.environment.os} |`);
	lines.push(`| Node | ${run.environment.node} |`);
	lines.push(`| OMP | ${run.environment.omp} |`);
	lines.push(`| WezTerm | ${run.environment.wezterm} |`);
	lines.push(`| State directory | ${reportPath(run.stateDir)} |`);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push("| Scenario | Status | Worker time | Wall time | Tokens | Checks |");
	lines.push("|---|---|---|---|---|---|");
	for (const scenario of run.scenarios) {
		lines.push(
			`| ${scenario.name} | ${scenario.status} | ${seconds(scenario.workerMs)} | ` +
				`${seconds(scenario.wallMs)} | ${formatUsage(scenario.usage)} | ${checkCounts(scenario)} |`,
		);
	}
	lines.push("");
	const total = combineReports(run.scenarios.map((scenario) => scenario.usage));
	lines.push(`Total tokens of all trial workers: ${formatUsage(total)}.`);
	lines.push("");
	for (const note of NOTES) lines.push(note);
	lines.push("");

	for (const scenario of run.scenarios) {
		lines.push(`## ${scenario.name}`);
		lines.push("");
		lines.push(`Worker: ${scenario.workerId ?? "none"}.`);
		lines.push("");
		lines.push(`Transcript: ${scenario.transcript === null ? "none" : reportPath(scenario.transcript)}.`);
		lines.push("");
		lines.push("The task was:");
		lines.push("");
		lines.push("```text");
		lines.push(scenario.task);
		lines.push("```");
		lines.push("");
		for (const check of scenario.checks) {
			const mark = check.pass ? "PASS" : "FAIL";
			lines.push(`- ${mark}: ${check.name}. ${oneLine(clean(check.detail))}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** True when every check of every scenario passed. */
export function trialPassed(run: TrialRun): boolean {
	return run.scenarios.every((scenario) => scenario.checks.every((check) => check.pass));
}

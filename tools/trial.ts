/**
 * The Windows trial.
 *
 * The trial runs four real tasks with real `omp` workers in real WezTerm
 * panes. It records what it saw and writes the report to
 * `docs/trials/windows-trial.md`.
 *
 * The script loads the extension through the test host, so it runs the code
 * in the tree. The state directory, the fixture and the worktrees are never
 * deleted, because they are the evidence of the run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { release as osRelease, type as osType, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { closePanesAndWait, createHost, sessionContext } from "../tests/harness.ts";
import { makeFixture } from "./trial-fixture.ts";
import { renderTrialReport, type ScenarioResult, type TrialRun, trialPassed } from "./trial-report.ts";
import { notStarted } from "./trial-scenario.ts";
import { cancelScenario, fixScenario, surveyScenario, timeoutScenario } from "./trial-scenarios.ts";
import { FIX_TASK, LONG_TASK, SURVEY_TASK, TRIAL_MODEL } from "./trial-tasks.ts";

/** The report of the trial, relative to the repository root. */
const REPORT = "docs/trials/windows-trial.md";

/** One scenario of the trial. */
interface Scenario {
	name: string;
	task: string;
	run: (host: ReturnType<typeof createHost>, fixture: string) => Promise<ScenarioResult>;
}

/** The version of a program, or null when the program cannot run. */
function programVersion(name: string): string | null {
	const probe = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true });
	if (probe.status !== 0) return null;
	return probe.stdout.trim();
}

/** The scenarios of the trial, in the order they run. */
const SCENARIOS: Scenario[] = [
	{ name: "Survey", task: SURVEY_TASK, run: surveyScenario },
	{ name: "Fix with a test", task: FIX_TASK, run: fixScenario },
	{ name: "Timeout", task: LONG_TASK, run: timeoutScenario },
	{ name: "Cancel", task: LONG_TASK, run: cancelScenario },
];

/** Run the trial and write the report. Returns the exit code. */
async function main(): Promise<number> {
	if (process.platform !== "win32") {
		console.error("The Windows trial runs on Windows only.");
		return 2;
	}
	if (!existsSync(join(process.cwd(), "package.json"))) {
		console.error("Run the trial from the repository root.");
		return 2;
	}
	const omp = programVersion("omp");
	const wezterm = programVersion("wezterm");
	if (omp === null || wezterm === null) {
		console.error("The trial needs the programs omp and wezterm on PATH.");
		return 2;
	}

	const stateDir = mkdtempSync(join(tmpdir(), "wt-trial-state-"));
	const fixture = makeFixture();
	const host = createHost({ stateDir, cwd: fixture });
	await host.fire("session_start", sessionContext(fixture));

	const startedAt = new Date().toISOString();
	const scenarios: ScenarioResult[] = [];
	try {
		for (const scenario of SCENARIOS) {
			// Each scenario is its own request, so the launch count stays low.
			await host.fire("input", {});
			try {
				scenarios.push(await scenario.run(host, fixture));
			} catch (error) {
				scenarios.push(
					notStarted(scenario.name, scenario.task, error instanceof Error ? error.message : String(error), 0),
				);
			}
		}
	} finally {
		// The state directory, the fixture and the worktrees stay on disk.
		// They are the evidence of the run.
		for (const workerId of host.workers) {
			await host.call("wezterm_worker_cancel", { workerId });
		}
		await closePanesAndWait([...host.panes]);
	}

	const run: TrialRun = {
		startedAt,
		environment: {
			os: `${osType()} ${osRelease()}`,
			node: process.version,
			omp,
			wezterm,
		},
		model: TRIAL_MODEL,
		stateDir,
		scenarios,
	};
	const report = join(process.cwd(), REPORT);
	mkdirSync(dirname(report), { recursive: true });
	writeFileSync(report, renderTrialReport(run), "utf8");
	console.log(`The report is at ${report}`);
	return trialPassed(run) ? 0 : 1;
}

process.exit(await main());

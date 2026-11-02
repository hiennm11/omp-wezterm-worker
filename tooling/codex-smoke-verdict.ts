/**
 * The verdict of a run of the Codex smoke test.
 *
 * The functions here are pure, so a test checks them without a pane. They
 * decide the exit code of the script and the verdict of the checks about the
 * machine of the user.
 */

/**
 * The result of one step.
 *
 * `not-run` is a step that the extension could not show. It needs a test file
 * that closes the criterion. `not-observable` is a step that the machine gave
 * nothing to observe, such as a machine with no daemon. It needs no test file,
 * and the report names it.
 */
export type StepOutcome = "pass" | "fail" | "not-run" | "not-observable";

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
 * The verdict of the daemon check of the smoke test.
 *
 * A machine that held no daemon before the run gives nothing to check, so
 * the check could not observe the machine. The smoke test never prints a
 * pass for a check that had nothing to observe, and it does not fail the run
 * for it either.
 */
export function daemonVerdict(before: number[], after: number[]): "pass" | "fail" | "not-observable" {
	if (before.length === 0) return "not-observable";
	return daemonSurvived(before, after) ? "pass" : "fail";
}

/**
 * The names of the steps that the machine gave nothing to observe.
 *
 * The report lists them, so the person that reads the run sees what the run
 * did not check.
 */
export function unobservedOf(lines: StepLine[]): string[] {
	return lines.filter((line) => line.outcome === "not-observable").map((line) => line.what);
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

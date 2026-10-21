/**
 * The task texts of the Windows trial.
 *
 * Every text is the exact text that the trial sends to a worker. The texts
 * live in one file, so the report and the run always show the same words.
 */

/** The model that every worker of the trial uses. */
export const TRIAL_MODEL = "omniroute/minimax/MiniMax-M3.1-Flash";

/** The task of the survey worker. It reads the fixture and changes nothing. */
export const SURVEY_TASK =
	"Read every file under src/ and test/ in the current directory. Do not change any file. " +
	"Reply with one line per exported function in src/, in the form <file>: <name>, and nothing else.";

/** The task of the fix worker. The test of the fixture fails before the fix. */
export const FIX_TASK =
	"Run the command node --test test/math.test.mjs. One test fails. Find the bug in src/math.mjs and fix it. " +
	"Do not change any file under test/. Run the command again until all tests pass. " +
	"Then reply with one sentence that names the bug.";

/** A task that keeps the worker busy for a while. It is the task of the live test. */
export const LONG_TASK =
	"Count from 1 to 200 slowly. Write one number per line into a file named count.txt " +
	"in the current working directory, using the write tool, one number at a time. " +
	"Then reply with the word DONE.";

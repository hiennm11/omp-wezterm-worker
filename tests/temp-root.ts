/**
 * The temp root of a test run.
 *
 * A test that writes a temp file asks the operating system for a temp
 * folder. The operating system gives the same folder to every test of every
 * run. A test that never removes its files leaves them behind, and the
 * machine then holds thousands of directories.
 *
 * This module gives the test process a temp folder of its own. The folder
 * sits in the temp folder of the machine. The module points the temp
 * variables of the process at that folder, so every temp file of the test
 * lands inside it. The module removes the folder when the process exits.
 *
 * The script `test:unit` loads this module with `--import`. The integration
 * tests do not load it. They start real programs that need the normal temp
 * folder of the machine.
 */

import { mkdtempSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The prefix of the folder that holds the temp files of the test process. */
const PREFIX = "wt-run-";

/** The folder that holds the temp files of this process. */
const root = mkdtempSync(join(tmpdir(), PREFIX));

/* The variable TEMP names the temp folder on Windows. The variables TMP and
   TMPDIR name it on the other systems. The module sets all three, so the
   tests of every system write inside the root. */
process.env.TEMP = root;
process.env.TMP = root;
process.env.TMPDIR = root;

process.on("exit", () => {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	} catch (error) {
		report(root, error);
	}
});

/**
 * Report a root that the process could not remove.
 *
 * The report goes to the standard error output of the process. The report
 * must not fail the run, so a write that fails ends the function.
 */
function report(root: string, error: unknown): void {
	const reason = error instanceof Error ? error.message : String(error);
	try {
		writeSync(2, `The temp root stayed behind: ${root} (${reason})\n`);
	} catch {
		/* a report that fails must not fail the run */
	}
}

/**
 * The check for a worker process that still runs.
 *
 * A worker process holds its working directory open. The test waits for the
 * process to end, so the directory can be removed on Windows.
 */

import { execFileSync } from "node:child_process";

/**
 * True while a worker process of the given directories still runs.
 *
 * The check looks at the whole process table. A worker of another test that
 * never ended must not keep this test waiting, so the check names the
 * directories of this test.
 */
export function workerProcessesRunning(directories: Iterable<string> = []): boolean {
	const dirs = [...directories];
	if (dirs.length === 0) return false;
	try {
		const patterns = dirs.map((d) => `'${d.replace(/'/g, "''")}'`);
		/* The inner filter needs its own variable. Inside a nested
		   Where-Object, `$_` is the directory, not the process. The script
		   skips its own process, because its command line names the
		   directories too. `@()` keeps `.Count` valid when one process
		   matches, because a single object has no `Count` in this shell. A
		   worker is any process whose command line names a directory of the
		   test: OMP passes it with `--session-dir`, and Claude Code passes it
		   with `--plugin-dir`. */
		const script =
			"$dirs = @(" +
			patterns.join(",") +
			"); @(Get-CimInstance Win32_Process | Where-Object { $p = $_; $p.ProcessId -ne $PID -and $p.CommandLine -and " +
			"($dirs | Where-Object { $p.CommandLine.Contains($_) } | Select-Object -First 1) }).Count";
		const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
		});
		return Number.parseInt(out.trim(), 10) > 0;
	} catch {
		// A process table that cannot be read means unknown, not running.
		return false;
	}
}

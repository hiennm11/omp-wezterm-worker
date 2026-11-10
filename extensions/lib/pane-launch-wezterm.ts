/**
 * The launch of a worker in a WezTerm pane.
 *
 * The launch opens a pane next to the pane of the main session, or in a tab
 * of its own. It starts the program in that pane. Only the pane that this
 * launch opened is closed on a failure, so a pane of the user is never
 * touched.
 *
 * The task goes into the argv of the program. WezTerm takes every argument as
 * one element, so a task with spaces, quotes and line breaks keeps its shape.
 */

import { backendLabel, readBackend } from "./backend.ts";
import type { Job } from "./job.ts";
import { killPane } from "./pane.ts";
import { weztermPaneId } from "./pane-id.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Start a program in a new WezTerm pane.
 *
 * Every value in `args` is its own argv element, so the task is never parsed
 * by a shell and quoting cannot go wrong. The task is the last element of the
 * argv, so the worker takes it as one instruction.
 *
 * On success the job holds its pane id and is `running`. Returns the reason
 * when the pane could not start, and leaves the job alone.
 */
export async function launchWezterm(
	rt: WorkerRuntime,
	job: Job,
	binary: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
	task?: string,
): Promise<string | null> {
	const argv = task ? [...args, task] : [...args];
	const weztermArgs =
		job.placement === "tab"
			? ["spawn", "--cwd", job.cwd, "--", binary, ...argv]
			: ["split-pane", "--right", "--cwd", job.cwd, "--", binary, ...argv];
	const res = await rt.wezterm(weztermArgs, env);
	if (res.code !== 0) return `wezterm ${job.placement} failed: ${describeFailure(res)}`;

	const paneId = weztermPaneIdOf(res.stdout);
	if (paneId === null) {
		return `wezterm did not return a pane id (got: ${JSON.stringify(res.stdout)})`;
	}
	job.paneId = paneId;
	job.status = "running";
	job.startedAt = Date.now();
	job.paneClosed = false;

	// Record which tab and window the pane landed in, so the user can find it.
	const listing = await rt.wezterm(["list", "--format", "json"]);
	if (listing.code === 0) {
		try {
			const panes = JSON.parse(listing.stdout) as Array<{
				pane_id: number;
				tab_id: number;
				window_id: number;
			}>;
			const found = panes.find((p) => weztermPaneId(p.pane_id) === paneId);
			if (found) {
				job.tabId = weztermPaneId(found.tab_id);
				job.windowId = weztermPaneId(found.window_id);
			}
		} catch {
			/* tab metadata is best-effort */
		}
	}

	// Name the tab so the user can find the worker in the tab bar. Only a
	// worker that got its own tab may rename that tab: with a split the pane
	// shares the user's tab, and renaming it would overwrite the title of
	// whatever the user is running.
	if (job.placement === "tab") {
		const title = `${backendLabel(readBackend(job))} worker ${job.id}`;
		await rt.wezterm(["set-tab-title", "--pane-id", paneId, title]);
	}
	return null;
}

/**
 * The pane id of the reply of WezTerm, or null when the reply holds no id.
 *
 * The reply holds a number. A reply that holds no number, or a number with
 * a fraction, is an error: a broken id must not look like a pane that does
 * not exist.
 */
function weztermPaneIdOf(stdout: string): string | null {
	const trimmed = stdout.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return weztermPaneId(Number(trimmed));
}

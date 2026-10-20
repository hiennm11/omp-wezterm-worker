/**
 * WezTerm panes.
 *
 * Every function here touches only the pane id it is given. No function lists
 * panes to act on them, so a pane that belongs to the user is never touched.
 */

import type { Job } from "./job.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

export async function paneExists(rt: WorkerRuntime, paneId: number): Promise<boolean> {
	const listing = await rt.wezterm(["list", "--format", "json"]);
	if (listing.code !== 0) return false;
	try {
		const panes = JSON.parse(listing.stdout) as Array<{ pane_id: number }>;
		return panes.some((p) => p.pane_id === paneId);
	} catch {
		return false;
	}
}

/**
 * Start the worker process in a new pane.
 *
 * Every value in `ompArgs` is its own argv element, so the task is never
 * parsed by a shell and quoting cannot go wrong. The placement decides the
 * WezTerm verb.
 *
 * On success the job holds its pane, tab and window ids and is `running`.
 * Returns the reason when the pane could not start, and leaves the job alone.
 */
export async function launchPane(rt: WorkerRuntime, job: Job, ompArgs: string[]): Promise<string | null> {
	const { ompBin } = rt.config;
	const weztermArgs =
		job.placement === "tab"
			? ["spawn", "--cwd", job.cwd, "--", ompBin, ...ompArgs]
			: ["split-pane", "--right", "--cwd", job.cwd, "--", ompBin, ...ompArgs];
	const res = await rt.wezterm(weztermArgs);
	if (res.code !== 0) return `wezterm ${job.placement} failed: ${describeFailure(res)}`;

	const paneId = Number.parseInt(res.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
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
			const found = panes.find((p) => p.pane_id === paneId);
			if (found) {
				job.tabId = found.tab_id;
				job.windowId = found.window_id;
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
		await rt.wezterm(["set-tab-title", "--pane-id", String(paneId), `OMP worker ${job.id}`]);
	}
	return null;
}

/**
 * Send text into a running worker's composer and submit it.
 *
 * `wezterm cli send-text` pastes by default, and a pasted block never submits
 * in the OMP TUI: the text lands in the composer but the Enter key does not
 * arrive, so the worker sits there waiting.
 *
 * `--no-paste` sends the bytes as individual key events instead of a
 * bracketed paste, so the trailing "\r" is delivered as a real Enter and the
 * composer submits. The "\r" is appended here, never by the caller.
 */
export async function sendToPane(
	rt: WorkerRuntime,
	paneId: number,
	text: string,
): Promise<{ ok: boolean; error: string | null }> {
	const res = await rt.wezterm(["send-text", "--no-paste", "--pane-id", String(paneId), `${text}\r`]);
	if (res.code !== 0) return { ok: false, error: describeFailure(res) };
	return { ok: true, error: null };
}

/**
 * Read the last few visible lines of a pane.
 *
 * This is a debug aid for a stalled worker, never a result source: the
 * worker's transcript stays the only authority on what the worker produced.
 */
export async function paneTail(rt: WorkerRuntime, paneId: number, lines: number): Promise<string> {
	const res = await rt.wezterm(["get-text", "--pane-id", String(paneId)]);
	if (res.code !== 0) return "";
	const rows = res.stdout.split("\n").filter((l) => l.trim());
	return rows.slice(-lines).join("\n");
}

/** Ask WezTerm to close one pane. Returns the failure reason, or null when the request was accepted. */
export async function killPane(rt: WorkerRuntime, paneId: number): Promise<string | null> {
	const res = await rt.wezterm(["kill-pane", "--pane-id", String(paneId)]);
	return res.code === 0 ? null : describeFailure(res);
}

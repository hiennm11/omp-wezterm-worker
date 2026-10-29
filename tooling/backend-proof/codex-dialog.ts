/**
 * The TUI of a Codex scenario that answers the approval dialogs.
 *
 * A scenario that answers a dialog needs a real TUI. The module attaches
 * that TUI to the scenario and waits for its first screen. The module
 * `codex-tui.ts` holds the functions that read the pane and that answer the
 * dialogs.
 *
 * The scenario `approval` keeps the answer of the person. It attaches its
 * own TUI and it never calls the answerer.
 */

import type { CodexHandle, CodexProofOptions } from "./codex-handle.ts";
import { attachTui, wait } from "./codex-server.ts";
import type { TuiPane } from "./codex-tui.ts";

/** The milliseconds that the proof waits for the first screen of the TUI. */
const TUI_START_MILLISECONDS = 3000;

/**
 * Attach the real TUI to a scenario and wait for its first screen.
 *
 * The function starts the TUI in a pane of WezTerm. It sets the pane of the
 * TUI in the handle of the scenario, so the stop of the scenario closes that
 * pane. The function waits three seconds for the first screen of the TUI.
 *
 * The thread id names the thread that the TUI shows. A scenario that
 * resumes a thread of another server passes that thread id.
 *
 * The function returns the pane of the TUI. It returns null when the TUI
 * did not start, and the reason of the failure.
 */
export async function attachScenarioTui(
	options: CodexProofOptions,
	handle: CodexHandle,
	bin: string,
	threadId: string = handle.threadId,
): Promise<{ pane: TuiPane | null; error: string | null }> {
	const env = {
		WEZTERM_PROOF_RUN_ID: options.runId,
		WEZTERM_PROOF_URL: handle.listener.baseUrl,
		WEZTERM_PROOF_TOKEN: handle.listener.token,
	};
	const tui = await attachTui(handle, bin, env, threadId);
	handle.tuiPaneId = tui.paneId;
	if (tui.paneId === null) return { pane: null, error: tui.error ?? "the TUI did not start" };
	await wait(TUI_START_MILLISECONDS);
	return { pane: { paneId: tui.paneId, text: "", gone: false }, error: null };
}

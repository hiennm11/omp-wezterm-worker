/**
 * The Claude Code backend on a pane runtime.
 *
 * The Claude Code backend gives its reporting contract to the program in a
 * file. The launch passes the path of that file, and the contract itself
 * never reaches the argv of the pane. The contract fits on Herdr too.
 *
 * The backend still refuses on WezTerm. The pane calls of
 * `extensions/lib/claude-session.ts` use `rt.herdr`, so a WezTerm pane would
 * never receive the text of the composer. A later task moves those calls to
 * the runtime seam.
 *
 * The refusal comes before every pane opens and before every program starts,
 * so a refused launch leaves no pane and no process on the machine.
 */

import type { PaneRuntime } from "./pane-runtime.ts";

/** The reason that the Claude Code backend refuses to run on WezTerm. */
export const CLAUDE_WEZTERM_REFUSAL =
	"The Claude Code backend does not run on WezTerm yet. " +
	"The pane calls of the Claude session still use the Herdr seam, so a WezTerm pane would never " +
	"receive the text of the composer. Issue 4 delivers the Claude Code workers end to end.";

/**
 * The reason that the Claude Code backend must not start, or null when it may
 * start.
 *
 * The function is pure. It reads no pane and no file.
 */
export function claudeRuntimeRefusal(runtime: PaneRuntime | null): string | null {
	if (runtime === "herdr") return null;
	return CLAUDE_WEZTERM_REFUSAL;
}

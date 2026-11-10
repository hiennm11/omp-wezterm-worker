/**
 * The Codex backend on Herdr.
 *
 * The Codex backend runs an app server in a pane of its own and a TUI in a
 * second pane. Herdr does not run that launch yet, so the backend refuses.
 *
 * The refusal comes before every pane opens and before every program starts,
 * so a refused launch leaves no pane and no process on the machine.
 */

/** The reason that the Codex backend refuses to run. */
export const CODEX_HERDR_REFUSAL = "The Codex backend does not support Herdr yet.";

/**
 * The reason that the Codex backend must not start, or null when it may
 * start.
 *
 * The function is pure. It reads no pane and no file.
 */
export function codexHerdrRefusal(): string | null {
	return CODEX_HERDR_REFUSAL;
}

/**
 * The Claude Code backend on Herdr.
 *
 * The Claude Code backend gives its reporting contract to the program in the
 * argument `--append-system-prompt`. The contract has many lines. Herdr
 * refuses an argument with a line break, so the program cannot start. The
 * backend refuses until the contract travels in a file.
 *
 * The refusal comes before every pane opens and before every program starts,
 * so a refused launch leaves no pane and no process on the machine.
 */

/** The reason that the Claude Code backend refuses to run. */
export const CLAUDE_HERDR_REFUSAL = "The Claude Code backend does not support Herdr yet.";

/**
 * The reason that the Claude Code backend must not start, or null when it may
 * start.
 *
 * The function is pure. It reads no pane and no file.
 */
export function claudeHerdrRefusal(): string | null {
	return CLAUDE_HERDR_REFUSAL;
}

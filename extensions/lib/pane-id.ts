/**
 * The pane ids of a worker.
 *
 * The pane id of a job is a string. Herdr names its panes like `w4:p1`.
 * WezTerm names its panes with a number. The extension keeps the id as a
 * string in the job, so the database and the tools work with one type.
 *
 * The conversion happens at the boundary of the CLI. A WezTerm pane id that
 * is not an integer is an error, never a null: a broken id must not look like
 * a pane that does not exist.
 */

/** The id of a pane, as the job holds it. */
export type PaneId = string;

/**
 * The number of a WezTerm pane id, or null when the id is not a number.
 *
 * The function refuses an id with a fraction and an id with other text. The
 * CLI of WezTerm names its panes with a whole number.
 */
export function weztermPaneNumber(paneId: PaneId): number | null {
	if (!/^\d+$/.test(paneId)) return null;
	const value = Number(paneId);
	if (!Number.isInteger(value)) return null;
	return value;
}

/**
 * The string of a WezTerm pane number, as the job holds it.
 *
 * The function is the boundary of the CLI. The number of the reply of the CLI
 * becomes a string, so the job keeps one type for every runtime.
 */
export function weztermPaneId(paneId: number): PaneId {
	return String(paneId);
}

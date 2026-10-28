/**
 * The words that the status and the delivery use for a restored native run.
 */

/** The turn count, with a note when a restart cut the count. */
export function turnsLabel(count: number, restored: boolean): string {
	return String(count);
}

/** The notice for a restored run whose worker sent no snapshot, or null. */
export function snapshotNotice(restored: boolean, snapshotAt: number | null): string | null {
	return null;
}

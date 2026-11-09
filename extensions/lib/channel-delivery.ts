/**
 * The notes of a channel in a delivery.
 *
 * A delivery of a finished worker carries the newest worker notes, so the
 * main session sees them without another call. The delivery names the older
 * notes and the tool that reads them.
 */

import type { ChannelNote } from "./channel-model.ts";
import { newestNotes } from "./channel-select.ts";

/** The number of worker notes that a delivery carries. */
export const DELIVERY_NOTE_LIMIT = 10;

/**
 * The text of the worker notes in a delivery.
 *
 * A worker without notes adds nothing to the delivery. A worker with more
 * notes than the limit adds the newest ones and one line that names the
 * older ones.
 */
export function formatDeliveryNotes(notes: ChannelNote[]): string {
	if (notes.length === 0) return "";
	const { notes: newest, older } = newestNotes(notes, DELIVERY_NOTE_LIMIT);
	const lines = newest.map((note) => `Note ${note.seq}: ${note.text}`);
	if (older === 0) return `Worker notes:\n${lines.join("\n")}`;
	return (
		`Worker notes:\n${lines.join("\n")}\n` +
		`${older} older worker note(s) are not in this delivery. ` +
		"Read them with wezterm_worker_notes_from_worker."
	);
}

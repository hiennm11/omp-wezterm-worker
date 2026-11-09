/**
 * The selection of the notes of a channel.
 *
 * The functions here are pure. They read no file and start no program, so a
 * test can prove the rules without a pane.
 */

import type { ChannelNote } from "./channel-model.ts";

/** The notes that a read returns, and the number that the reply names. */
export interface ChannelSelection {
	/** The notes that the read returns, oldest first. */
	notes: ChannelNote[];
	/** The highest number of a note of the channel, even when the read is empty. */
	highestSeq: number;
}

/**
 * The notes that come after a number.
 *
 * The number 0 gives every note. The reply names the highest number of the
 * channel, so the caller can ask for the newer notes later.
 */
export function selectNotes(notes: ChannelNote[], afterSeq: number): ChannelSelection {
	const from = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0;
	let highestSeq = 0;
	for (const note of notes) {
		if (note.seq > highestSeq) highestSeq = note.seq;
	}
	return { notes: notes.filter((note) => note.seq > from), highestSeq };
}

/**
 * The newest notes of a channel, oldest first.
 *
 * The list holds at most `limit` notes. The result names the number of the
 * notes that the list did not hold.
 */
export function newestNotes(notes: ChannelNote[], limit: number): { notes: ChannelNote[]; older: number } {
	const sorted = [...notes].sort((a, b) => a.seq - b.seq);
	if (sorted.length <= limit) return { notes: sorted, older: 0 };
	const kept = sorted.slice(sorted.length - limit);
	return { notes: kept, older: sorted.length - kept.length };
}

/**
 * The channel of a Claude Code worker, as the bridge serves it.
 *
 * The mod of a worker never reads a channel file. It asks the bridge for the
 * notes and the bridge gives the text that the worker reads. The shape of a
 * note therefore lives in one place.
 */

import {
	formatChannelNotes,
	noteDeliveryText,
	noteId,
	noteTextRefusal,
	noteWrittenText,
} from "./channel-model.ts";
import { selectNotes } from "./channel-select.ts";
import { appendChannelNote, readChannelNotes } from "./channel-store.ts";

/** One note of the main session that the worker has not received yet. */
export interface ChannelDelivery {
	/** The id of the note. The id is the key of a delivery. */
	id: string;
	/** The number of the note in the main file. */
	seq: number;
	/** The text that the worker reads. */
	text: string;
}

/** The notes of the main session that the bridge gives to a worker. */
export interface MainNotes {
	/** The notes after the number that the caller gave. */
	notes: ChannelDelivery[];
	/** The highest number of the channel, even when the list is empty. */
	highestSeq: number;
	/** The text of the reply that names the notes. */
	text: string;
}

/** The channel that the bridge serves to one worker. */
export interface BridgeChannel {
	/** The notes of the main session after a number. */
	mainNotes(afterSeq: number): MainNotes;
	/** Save a note of the worker, or refuse the text of the note. */
	appendNote(text: string): { seq: number; text: string } | { refusal: string };
}

/**
 * The channel of one session directory.
 *
 * The bridge serves the channel of the run that it belongs to. The notes of
 * the main session live in the main file of the session directory, and the
 * notes of the worker live in the worker file of the same directory.
 */
export function channelOf(sessionDir: string, runId: string): BridgeChannel {
	return {
		mainNotes(afterSeq: number): MainNotes {
			const selection = selectNotes(readChannelNotes(sessionDir, "main"), afterSeq);
			const notes = selection.notes.map((note) => ({
				id: noteId("main", note.seq),
				seq: note.seq,
				text: noteDeliveryText(note),
			}));
			return {
				notes,
				highestSeq: selection.highestSeq,
				text: formatChannelNotes(selection.notes, selection.highestSeq, "the main session"),
			};
		},
		appendNote(text: string): { seq: number; text: string } | { refusal: string } {
			const refusal = noteTextRefusal(text);
			if (refusal) return { refusal };
			const note = appendChannelNote(sessionDir, "worker", {
				runId,
				text: text.trim(),
				at: Date.now(),
			});
			return { seq: note.seq, text: noteWrittenText(note.seq) };
		},
	};
}

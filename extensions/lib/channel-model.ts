/**
 * The note that travels over the worker channel.
 *
 * The main session and one worker exchange short notes. A note changes no
 * state of the task. The model lives in the library, so the decision
 * functions do not depend on the tool modules.
 */

import { REMOVED_BACKEND } from "./backend.ts";
import { REMOVED_BACKEND_REFUSAL } from "./removed-backend.ts";

/**
 * The side of a channel.
 *
 * The side names the writer of a file. The main session writes the main file
 * and the worker writes the worker file, so each file has one writer.
 */
export type ChannelSide = "main" | "worker";

/** The longest text that a note accepts. */
export const MAX_NOTE_LENGTH = 4000;

/** One note of a channel. */
export interface ChannelNote {
	/** The number of the note in its file. The first note has the number 1. */
	seq: number;
	/** The run that wrote the note. A note of the main session names no run. */
	runId: string | null;
	/** The text of the note. */
	text: string;
	/** The time of the note, in milliseconds since the epoch. */
	at: number;
}

/**
 * The reason that a note text is refused, or null when the text is accepted.
 *
 * A note without text proves nothing. A note longer than the limit does not
 * fit into a delivery of the main session.
 */
export function noteTextRefusal(text: string): string | null {
	const body = typeof text === "string" ? text.trim() : "";
	if (!body) return "A note needs text.";
	if (body.length > MAX_NOTE_LENGTH) return `A note holds at most ${MAX_NOTE_LENGTH} characters.`;
	return null;
}

/**
 * The reason that a backend has no channel, or null when it has one.
 *
 * A Claude Code worker has no channel today. The reply says so, because a
 * tool that fails without a word is a fault the user cannot see.
 *
 * A run of the removed backend has no channel either. Its refusal names the
 * removed backend, so the user knows that the run is old.
 */
export function channelBackendRefusal(backend: string): string | null {
	if (backend === "omp") return null;
	if (backend === REMOVED_BACKEND) return REMOVED_BACKEND_REFUSAL;
	return "The Claude Code backend does not support the worker channel yet.";
}

/**
 * The text of a list of notes.
 *
 * The reply names the highest number of the channel, so the caller can ask
 * for the newer notes later.
 */
export function formatChannelNotes(notes: ChannelNote[], highestSeq: number, source: string): string {
	if (notes.length === 0) {
		return `The channel holds no note from ${source}. The highest note number is ${highestSeq}.`;
	}
	const lines = notes.map((note) => `Note ${note.seq}: ${note.text}`);
	return `${lines.join("\n")}\n\nThe highest note number is ${highestSeq}.`;
}

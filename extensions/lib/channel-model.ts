/**
 * The note that travels over the worker channel.
 *
 * The main session and one worker exchange short notes. A note changes no
 * state of the task. The model lives in the library, so the decision
 * functions do not depend on the tool modules.
 *
 * The mod of a Claude Code worker never parses a channel file. It asks the
 * bridge for the notes and the bridge gives the text that the worker reads.
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

/** The label that a note of the main session carries when it reaches a worker. */
export const NOTE_LABEL = "Note from the main session:";

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
 * The id of a note.
 *
 * The id names the note in every place that the note appears. The id is the
 * key of a delivery, so a note reaches a worker one time.
 */
export function noteId(side: ChannelSide, seq: number): string {
	return `${side}-${seq}`;
}

/**
 * The text that a note carries when it reaches a worker.
 *
 * A Claude Code worker reads the note as its next prompt. The label tells
 * the worker that the text is a note and not a task.
 */
export function noteDeliveryText(note: ChannelNote): string {
	return `${NOTE_LABEL} ${note.text}`;
}

/**
 * The headline that a written note gets.
 *
 * The worker of OMP and the worker of Claude Code write a note with the same
 * words, so the main session reads the same reply for both backends.
 */
export function noteWrittenText(seq: number): string {
	return `The note is in the channel of the main session. It is note ${seq}.`;
}

/**
 * The reason that a backend has no channel, or null when it has one.
 *
 * Every backend that the extension runs today has a channel. A run of the
 * removed backend has no channel, because no worker of that backend runs.
 * Its refusal names the removed backend, so the user knows that the run is
 * old.
 */
export function channelBackendRefusal(backend: string): string | null {
	if (backend === REMOVED_BACKEND) return REMOVED_BACKEND_REFUSAL;
	return null;
}

/**
 * The reason that a worker of a backend cannot read the channel of the main
 * session, or null when it can.
 *
 * The mod of a Claude Code worker reads the channel through the bridge. The
 * worker of OMP reads the file of the channel. Both backends have a channel.
 */
export function workerChannelRefusal(backend: string | undefined): string | null {
	return channelBackendRefusal(backend ?? "omp");
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

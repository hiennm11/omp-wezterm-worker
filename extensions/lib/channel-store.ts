/**
 * The channel of a worker.
 *
 * The main session and the worker exchange short notes. Each side writes its
 * own file, so the two sides never write the same bytes. The files live
 * beside the transcript of the run, so a resume of the run finds them.
 *
 * The files follow the rule of the report store: one append per note, and a
 * partial line is skipped while the file is written.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChannelNote, ChannelSide } from "./channel-model.ts";

/**
 * The file of one side of the channel of a session directory.
 *
 * The main session writes the main file. The worker writes the worker file.
 * Each file has one writer, so the two sides never write the same bytes.
 */
export function channelFile(sessionDir: string, side: ChannelSide): string {
	const name =
		side === "main" ? ".wezterm-worker-channel-main.jsonl" : ".wezterm-worker-channel-worker.jsonl";
	return join(sessionDir, name);
}

/**
 * Append one note to the file of one side of a channel.
 *
 * The write is one append. The function returns the note with its number.
 */
export function appendChannelNote(
	sessionDir: string,
	side: ChannelSide,
	note: { runId: string | null; text: string; at: number },
): ChannelNote {
	const full: ChannelNote = { ...note, seq: nextSeq(sessionDir, side) };
	appendFileSync(channelFile(sessionDir, side), `${JSON.stringify(full)}\n`, "utf8");
	return full;
}

/**
 * Read the notes of one side of the channel of a session directory.
 *
 * A missing file gives an empty list. A line that is not valid JSON is
 * skipped, because a partial line is normal while the file is written.
 */
export function readChannelNotes(sessionDir: string, side: ChannelSide): ChannelNote[] {
	let raw: string;
	try {
		raw = readFileSync(channelFile(sessionDir, side), "utf8");
	} catch {
		return [];
	}
	const notes: ChannelNote[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as ChannelNote;
			if (!parsed || typeof parsed.seq !== "number" || typeof parsed.text !== "string") continue;
			notes.push(parsed);
		} catch {
			/* a partial line is normal while the file is written */
		}
	}
	return notes;
}

/** The number that the next note of a side gets. */
function nextSeq(sessionDir: string, side: ChannelSide): number {
	let highest = 0;
	for (const note of readChannelNotes(sessionDir, side)) {
		if (note.seq > highest) highest = note.seq;
	}
	return highest + 1;
}

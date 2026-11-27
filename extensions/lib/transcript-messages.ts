/**
 * The user messages that a transcript records.
 *
 * A steer call and the launch of a resume both need the messages that a
 * transcript gained after a send. The two must compare the messages the
 * same way, so the comparison lives in this module.
 *
 * The functions read no pane and no process. A test calls them with a real
 * transcript in a temporary directory.
 */

import { listSessionFiles, summarizeSession } from "./transcript.ts";

/**
 * The user messages that the worker's transcript records, in order.
 *
 * The order matters, because only the messages that the transcript gained
 * after the send can confirm that send.
 */
export function recordedUserMessages(sessionDir: string): string[] {
	const files = listSessionFiles(sessionDir);
	if (files.length === 0) return [];
	return summarizeSession(files[0]).userMessages;
}

/**
 * The messages that the transcript gained after the send.
 *
 * Each recorded text is matched against the messages of the baseline. A text
 * that the baseline already held does not confirm the send, unless the
 * transcript records that text again. The comparison uses the trimmed text,
 * so a change of spacing does not look like a new message.
 */
export function freshMessages(before: string[], after: string[]): string[] {
	const remaining = new Map<string, number>();
	for (const text of before) {
		const key = text.trim();
		remaining.set(key, (remaining.get(key) ?? 0) + 1);
	}
	const fresh: string[] = [];
	for (const text of after) {
		const key = text.trim();
		const count = remaining.get(key) ?? 0;
		if (count > 0) {
			remaining.set(key, count - 1);
		} else {
			fresh.push(key);
		}
	}
	return fresh;
}

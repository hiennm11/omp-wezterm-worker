/**
 * The transcript helpers of the test harness.
 *
 * The transcript is the record of what a worker did, so the tests read it.
 */

import { readFileSync } from "node:fs";

import { listSessionFiles } from "../extensions/lib/transcript.ts";

/** One message from a worker transcript. */
export interface TranscriptMessage {
	role: "user" | "assistant" | "toolResult";
	text: string;
	toolCalls: string[];
}

/**
 * Read the messages of a worker's transcript in order.
 *
 * The transcript is the worker's record, so it is the evidence for what the
 * worker did and when.
 */
export function readTranscript(sessionDir: string): TranscriptMessage[] {
	const files = listSessionFiles(sessionDir);
	if (files.length === 0) return [];
	const messages: TranscriptMessage[] = [];
	for (const line of readFileSync(files[0], "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: {
			type?: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string; name?: string }> };
		};
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
		messages.push({
			role,
			text: blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
			toolCalls: blocks.filter((b) => b.type === "toolCall").map((b) => b.name ?? "?"),
		});
	}
	return messages;
}

/**
 * The answer a worker gave after its last user message.
 *
 * A steering message arrives as a user message. The answer that follows it
 * is the answer to that message.
 */
export function answerAfterLastUser(messages: TranscriptMessage[]): string | null {
	let index = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			index = i;
			break;
		}
	}
	if (index < 0) return null;
	for (let i = index + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant" && message.text && message.toolCalls.length === 0) {
			return message.text;
		}
	}
	return null;
}

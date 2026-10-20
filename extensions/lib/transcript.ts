/**
 * Reading a worker's transcript.
 *
 * The transcript is the worker's session JSONL. It is the authoritative record
 * of what the worker did and said; the pane only shows a rendering of it.
 *
 * Everything here is pure with respect to the filesystem: a summary is
 * computed from the contents of one file, and the completion rule is a
 * predicate over that summary.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

export interface SessionSummary {
	userMessages: string[];
	assistantTexts: string[];
	toolCalls: number;
	toolResults: number;
	/** Text of the newest assistant message, but only if it issued no tool call. */
	finalText: string | null;
	/** Name of the tool the worker is running right now, if any. */
	currentTool: string | null;
	/** Text of the newest assistant message, preamble included. */
	latestText: string | null;
	/** Number of assistant turns (assistant messages) seen so far. */
	turns: number;
	/** Assistant turns counted since the newest user message. */
	turnsSinceLastUser: number;
	/** Tool calls counted since the newest user message. */
	toolCallsSinceLastUser: number;
	/** Tool results counted since the newest user message. */
	toolResultsSinceLastUser: number;
	/**
	 * Ordinal of the assistant message that produced `finalText`, counting
	 * every assistant message from the start of the transcript. A job records
	 * the ordinal that existed when it started, so a resumed worker does not
	 * report an earlier answer as its new result.
	 */
	finalTextIndex: number;
}

export function emptySummary(): SessionSummary {
	return {
		userMessages: [],
		assistantTexts: [],
		toolCalls: 0,
		toolResults: 0,
		finalText: null,
		currentTool: null,
		latestText: null,
		turns: 0,
		turnsSinceLastUser: 0,
		toolCallsSinceLastUser: 0,
		toolResultsSinceLastUser: 0,
		finalTextIndex: 0,
	};
}

/**
 * The transcript files in a session directory, newest first.
 *
 * A session directory holds one JSONL per session; the newest is the live
 * one.
 */
export function listSessionFiles(sessionDir: string): string[] {
	try {
		if (!existsSync(sessionDir)) return [];
		return readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	} catch {
		return [];
	}
}

/** Names of the tool calls in one assistant message. */
function toolCallNames(blocks: ContentBlock[]): string[] {
	return blocks.filter((b) => b.type === "toolCall").map((b) => b.name ?? "?");
}

/**
 * Summarize a transcript.
 *
 * A line that is not a message, or not valid JSON, is skipped: the file is
 * being written while it is read, so a partial line is normal.
 */
export function summarizeSession(file: string): SessionSummary {
	const summary = emptySummary();
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return summary;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: ContentBlock[] } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
		if (role === "user") {
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (!text) continue;
			summary.userMessages.push(text);
			// A new user message starts a fresh stretch of work. Turns
			// counted before it belong to an earlier request, so the
			// completion check looks only at what follows. Without this, a
			// resumed worker would immediately report the previous
			// request's answer as its new result.
			summary.turnsSinceLastUser = 0;
			summary.finalText = null;
			summary.toolCallsSinceLastUser = 0;
			summary.toolResultsSinceLastUser = 0;
		} else if (role === "assistant") {
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			const calls = blocks.filter((b) => b.type === "toolCall").length;
			summary.toolCalls += calls;
			summary.toolCallsSinceLastUser += calls;
			summary.turns += 1;
			summary.turnsSinceLastUser += 1;
			if (text) {
				summary.assistantTexts.push(text);
				summary.latestText = text;
			}
			// An assistant message that issues a tool call is not the end of the
			// turn. Its text is a preamble ("I'll read that file."), so it must
			// not be treated as the worker's answer. Only a text-only assistant
			// message concludes a turn.
			summary.finalText = calls === 0 && text ? text : null;
			if (calls === 0 && text) summary.finalTextIndex = summary.turns;
			// A tool call without its result means the worker is inside that
			// tool right now. The result resets it.
			summary.currentTool = calls > 0 ? toolCallNames(blocks).join(", ") : null;
		} else if (role === "toolResult") {
			summary.toolResults += 1;
			summary.toolResultsSinceLastUser += 1;
			summary.currentTool = null;
		}
	}
	return summary;
}

/**
 * A worker turn is complete when its session file ends with a text-only
 * assistant message and no tool call is still outstanding.
 *
 * The counts are the ones taken since the newest user message. A resumed
 * worker opens on a transcript that already holds a finished turn, so the
 * absolute counts would report that old answer as the new result before the
 * worker had done any work.
 */
export function isTurnComplete(summary: SessionSummary): boolean {
	return (
		summary.finalText !== null &&
		summary.turnsSinceLastUser > 0 &&
		summary.toolCallsSinceLastUser <= summary.toolResultsSinceLastUser
	);
}

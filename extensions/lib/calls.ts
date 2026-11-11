/**
 * The calls of a worker transcript.
 *
 * The transcript holds one JSONL file per session. A `toolCall` block holds
 * the id of the call. A `toolResult` message holds the id of the call that it
 * settles. The parser pairs them by value.
 *
 * A call that starts a background job names the job in the details of its
 * result. The transcript names the end of the job in an `async-result` entry,
 * in the result of the tool `wait`, in the result of a read of `proc://bg_N`
 * or in the result of a kill of that job. Every name settles the call.
 */

import { readFileSync } from "node:fs";

import {
	type BackgroundResult,
	backgroundResultsOf,
	callResultsOf,
	procResultsOf,
	waitResultsOf,
} from "./background-jobs.ts";

export { type BackgroundResult, SETTLED_JOB_STATUSES } from "./background-jobs.ts";

/** One tool call in a transcript. */
export interface ObservedCall {
	/** The id of the call. The result of this call carries the same id. */
	callId: string;
	/** The name of the tool. */
	name: string;
	/** The number of the assistant message that issued the call. */
	turn: number;
	/** True when the transcript holds a result for this call. */
	settled: boolean;
	/** The job id of a background call, when the result names one. */
	jobId: string | null;
	/** The command that the call ran, when the call names one. */
	command: string | null;
}

/** The calls of one transcript, in the order they appear. */
export interface CallLedger {
	calls: ObservedCall[];
	/** The background jobs that the transcript reports as finished. */
	backgroundResults: BackgroundResult[];
	/** The number of assistant messages in the transcript. */
	turns: number;
	/** The number of user messages in the transcript. */
	userMessages: number;
	/** The id of the last user message entry, when the transcript holds one. */
	lastUserEntryId: string | null;
	/** The id of the session header, when the transcript holds one. */
	sessionId: string | null;
	/** True when the last assistant message ended its turn with text and held no tool call. */
	lastAssistantEndedTurn: boolean;
	/** True when a tool result follows the last assistant message. */
	toolResultAfterLastAssistant: boolean;
	/** The id of the last transcript entry. */
	lastEntryId: string | null;
	/** The timestamp of the last transcript entry, when available. */
	lastEntryAt: number | null;
}

/** The fields of a transcript entry that the parser reads. */
interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string | number;
	customType?: string;
	details?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		details?: unknown;
	};
}

/** A content block of an assistant message. */
interface Block {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

/**
 * Read the calls of one transcript file.
 *
 * A file that cannot be read gives an empty ledger. A line that is not valid
 * JSON is skipped, because the file is written while it is read.
 */
export function readCallLedger(file: string): CallLedger {
	const ledger: CallLedger = {
		calls: [],
		backgroundResults: [],
		turns: 0,
		userMessages: 0,
		lastUserEntryId: null,
		sessionId: null,
		lastAssistantEndedTurn: false,
		toolResultAfterLastAssistant: false,
		lastEntryId: null,
		lastEntryAt: null,
	};
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return ledger;
	}
	const byCallId = new Map<string, ObservedCall>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			continue;
		}
		ledger.lastEntryId = typeof entry.id === "string" ? entry.id : ledger.lastEntryId;
		if (typeof entry.timestamp === "number") ledger.lastEntryAt = entry.timestamp;
		else if (typeof entry.timestamp === "string") {
			const timestamp = Date.parse(entry.timestamp);
			ledger.lastEntryAt = Number.isNaN(timestamp) ? null : timestamp;
		}
		if (entry.type === "session" && typeof entry.id === "string") {
			ledger.sessionId = entry.id;
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === "async-result") {
			ledger.backgroundResults.push(...backgroundResultsOf(entry.details));
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			ledger.userMessages += 1;
			ledger.lastUserEntryId = entry.id ?? null;
			continue;
		}
		if (message.role === "assistant") {
			ledger.turns += 1;
			const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
			let hasText = false;
			let hasToolCall = false;
			for (const block of blocks) {
				if (block.type === "text") hasText = true;
				if (block.type === "toolCall") hasToolCall = true;
				if (block.type !== "toolCall" || !block.id) continue;
				const call: ObservedCall = {
					callId: block.id,
					name: block.name ?? "?",
					turn: ledger.turns,
					settled: false,
					jobId: null,
					command: commandOf(block.arguments),
				};
				ledger.calls.push(call);
				byCallId.set(block.id, call);
			}
			// A turn ends at a text block that holds no tool call. A turn that
			// holds a tool call continues after the result of that call.
			ledger.lastAssistantEndedTurn = hasText && !hasToolCall;
			ledger.toolResultAfterLastAssistant = false;
			continue;
		}
		if (message.role === "toolResult") {
			// The model thinks after the result of a call. The result is the
			// last entry of the transcript while the model thinks.
			if (ledger.turns > 0) ledger.toolResultAfterLastAssistant = true;
			if (message.toolName === "wait") {
				ledger.backgroundResults.push(...waitResultsOf(message.details));
			}
			// A read or a kill of a background job names the status of that
			// job. A result of any other tool names no job.
			ledger.backgroundResults.push(...procResultsOf(message.details));
			if (!message.toolCallId) continue;
			const call = byCallId.get(message.toolCallId);
			if (!call) continue;
			call.settled = true;
			call.jobId = backgroundJobId(message.details);
			// The result of the call that started a job names the end of that
			// job when the call already returned.
			ledger.backgroundResults.push(...callResultsOf(message.details));
		}
	}
	return ledger;
}

/**
 * The job id of a result that starts a background job.
 *
 * The details of the result hold the job id. A result of any other tool
 * holds no job, so it returns null.
 */
function backgroundJobId(details: unknown): string | null {
	if (!details || typeof details !== "object") return null;
	const async = (details as Record<string, unknown>).async;
	if (!async || typeof async !== "object") return null;
	const jobId = (async as Record<string, unknown>).jobId;
	return typeof jobId === "string" ? jobId : null;
}

/**
 * The command that a call names in its arguments.
 *
 * The arguments of a call hold the command under the key `command`. A call
 * of another tool names no command, so it returns null.
 */
function commandOf(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const command = (args as Record<string, unknown>).command;
	return typeof command === "string" ? command : null;
}

/**
 * The calls of one run that no result settles.
 *
 * A call without a result is outstanding. It blocks a completion report.
 */
export function unsettledCalls(ledger: CallLedger): ObservedCall[] {
	return ledger.calls.filter((call) => !call.settled);
}

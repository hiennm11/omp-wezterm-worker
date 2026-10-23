/**
 * The calls of a worker transcript.
 *
 * The transcript holds one JSONL file per session. A `toolCall` block holds
 * the id of the call. A `toolResult` message holds the id of the call that it
 * settles. The parser pairs them by value.
 *
 * A call that starts a background job names the job in the details of its
 * result. The transcript gets a separate entry when the job ends. That entry
 * settles the call.
 */

import { readFileSync } from "node:fs";

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
}

/** One background job that the transcript reports as finished. */
export interface BackgroundResult {
	/** The id of the job. */
	jobId: string;
	/** The status of the job, for example `completed` or `failed`. */
	status: string;
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
}

/** The fields of a transcript entry that the parser reads. */
interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
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
			for (const block of blocks) {
				if (block.type !== "toolCall" || !block.id) continue;
				const call: ObservedCall = {
					callId: block.id,
					name: block.name ?? "?",
					turn: ledger.turns,
					settled: false,
					jobId: null,
				};
				ledger.calls.push(call);
				byCallId.set(block.id, call);
			}
			continue;
		}
		if (message.role === "toolResult" && message.toolCallId) {
			const call = byCallId.get(message.toolCallId);
			if (!call) continue;
			call.settled = true;
			call.jobId = backgroundJobId(message.details);
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

/** The finished background jobs that one entry names. */
function backgroundResultsOf(details: unknown): BackgroundResult[] {
	if (!details || typeof details !== "object") return [];
	const jobs = (details as Record<string, unknown>).jobs;
	if (!Array.isArray(jobs)) return [];
	const found: BackgroundResult[] = [];
	for (const job of jobs) {
		if (!job || typeof job !== "object") continue;
		const record = job as Record<string, unknown>;
		const jobId = record.jobId;
		const status = record.status;
		if (typeof jobId !== "string" || typeof status !== "string") continue;
		found.push({ jobId, status });
	}
	return found;
}

/**
 * The calls of one run that no result settles.
 *
 * A call without a result is outstanding. It blocks a completion report.
 */
export function unsettledCalls(ledger: CallLedger): ObservedCall[] {
	return ledger.calls.filter((call) => !call.settled);
}

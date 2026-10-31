/**
 * The events of a Codex worker.
 *
 * The app server of Codex sends the state of a thread as a stream of
 * messages. This module turns one message into the observations of a native
 * run. The reducer and the ledger of the run then do the rest.
 *
 * The translator holds no state of its own. The caller gives it the totals
 * of the session, and the caller holds the next totals.
 */

import type { BridgeObservation } from "./claude-bridge.ts";

/** One message of the app server. */
export interface CodexMessage {
	/** The method of the message, with the prefix of the proof. */
	source: string;
	/** The parameters of the message. */
	payload: Record<string, unknown>;
}

/** The token counts that the app server reports. */
export interface CodexTokenCounts {
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
}

/** The totals that a session holds between two messages. */
export interface CodexUsageState {
	/** The id of the running turn, or null when no turn runs. */
	turnId: string | null;
	/** The counts that the thread reported before the running turn started. */
	base: CodexTokenCounts | null;
	/** The last counts that the running turn reported. */
	turn: CodexTokenCounts | null;
	/** The last counts that the thread reported. */
	last: CodexTokenCounts | null;
}

/** The totals of a thread that reported nothing yet. */
export function emptyCodexUsage(): CodexUsageState {
	return { turnId: null, base: null, turn: null, last: null };
}

/** The item types that run work. Every other type writes no call. */
const WORK_TYPES: string[] = [
	"commandExecution",
	"fileChange",
	"mcpToolCall",
	"dynamicToolCall",
	"collabAgentToolCall",
];

/** The name of the report tool. The report file is its own evidence. */
const REPORT_TOOL = "wezterm_worker_report";

/**
 * Translate one message of the app server into the observations of a run.
 *
 * The function reads the totals of the session. It writes nothing, so the
 * caller holds the next totals with `advanceCodexUsage`.
 */
export function translateCodexMessage(message: CodexMessage, usage: CodexUsageState): BridgeObservation[] {
	switch (message.source) {
		case "turn/started": {
			const turnId = turnIdOf(message.payload);
			if (!turnId) return [];
			return [observation(message, "turn.start", { turnId })];
		}
		case "turn/completed": {
			const turnId = turnIdOf(message.payload);
			if (!turnId) return [];
			return [observation(message, "turn.complete", { turnId, usage: usageOfTurn(usage) })];
		}
		case "thread/tokenUsage/updated": {
			/* The usage of a turn arrives with its end. The update itself
			   opens no cycle, but it carries the counts of the turn. */
			return [];
		}
		case "item/started": {
			const item = itemOf(message.payload);
			if (!item) return [];
			if (item.type === "userMessage") {
				const instructionId = stringOf(item.clientId);
				if (!instructionId) return [];
				return [
					observation(message, "instruction.delivered", {
						uuid: stringOf(item.id) ?? instructionId,
						instructionId,
					}),
				];
			}
			if (!WORK_TYPES.includes(itemType(item))) return [];
			const callId = stringOf(item.id);
			if (!callId) return [];
			const tool = toolOf(item);
			/* A call to the report tool opens no row. The report file is its
			   own evidence, and the ledger already ignores that tool. */
			if (tool.endsWith(REPORT_TOOL)) return [];
			return [observation(message, "tool.call.opened", { callId, tool })];
		}
		case "item/completed": {
			const item = itemOf(message.payload);
			if (!item) return [];
			if (!WORK_TYPES.includes(itemType(item))) return [];
			const callId = stringOf(item.id);
			if (!callId) return [];
			const status = stringOf(item.status);
			return [
				observation(message, "tool.call.settled", {
					callId,
					tool: toolOf(item),
					denied: status === "declined",
					isError: status === "failed",
				}),
			];
		}
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval": {
			const callId = stringOf(message.payload.itemId);
			if (!callId) return [];
			return [
				observation(message, "tool.check", {
					callId,
					tool: approvalTool(message.source),
					decision: "ask",
				}),
			];
		}
		default:
			return [];
	}
}

/**
 * The totals that the session holds after one message.
 *
 * The function reads the totals of the session and gives the next totals
 * back. It writes nothing, so the caller keeps the only state.
 */
export function advanceCodexUsage(message: CodexMessage, usage: CodexUsageState): CodexUsageState {
	switch (message.source) {
		case "turn/started": {
			const turnId = turnIdOf(message.payload);
			if (!turnId) return usage;
			return { turnId, base: usage.last, turn: null, last: usage.last };
		}
		case "turn/completed": {
			return { turnId: null, base: usage.last, turn: null, last: usage.last };
		}
		case "thread/tokenUsage/updated": {
			const counts = countsOf(message.payload);
			if (!counts) return usage;
			const turnId = stringOf(message.payload.turnId);
			const turn = usage.turnId !== null && turnId === usage.turnId ? counts : usage.turn;
			return { turnId: usage.turnId, base: usage.base, turn, last: counts };
		}
		default:
			return usage;
	}
}

/** The id of the turn that a message names. */
function turnIdOf(payload: Record<string, unknown>): string | null {
	const turn = payload.turn;
	if (!turn || typeof turn !== "object") return null;
	return stringOf((turn as Record<string, unknown>).id);
}

/** The item that a message carries. */
function itemOf(payload: Record<string, unknown>): Record<string, unknown> | null {
	const item = payload.item;
	if (!item || typeof item !== "object") return null;
	return item as Record<string, unknown>;
}

/** The tool name of an item. */
function toolOf(item: Record<string, unknown>): string {
	if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
		return stringOf(item.tool) ?? stringOf(item.type) ?? "unknown";
	}
	return stringOf(item.type) ?? "unknown";
}

/** The type of an item. */
function itemType(item: Record<string, unknown>): string {
	return stringOf(item.type) ?? "";
}

/** The tool name that an approval request names. */
function approvalTool(source: string): string {
	return source === "item/fileChange/requestApproval" ? "fileChange" : "commandExecution";
}

/** A string of a value, or null when the value holds none. */
function stringOf(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The counts that a usage update carries. */
function countsOf(payload: Record<string, unknown>): CodexTokenCounts | null {
	const usage = payload.tokenUsage;
	if (!usage || typeof usage !== "object") return null;
	const total = (usage as Record<string, unknown>).total;
	if (!total || typeof total !== "object") return null;
	const value = total as Record<string, unknown>;
	const counts: CodexTokenCounts = {};
	const input = numberOf(value.inputTokens);
	const output = numberOf(value.outputTokens);
	const cached = numberOf(value.cachedInputTokens);
	const cacheWrite = numberOf(value.cacheWriteInputTokens);
	if (input !== null) counts.inputTokens = input;
	if (output !== null) counts.outputTokens = output;
	if (cached !== null) counts.cachedInputTokens = cached;
	if (cacheWrite !== null) counts.cacheWriteInputTokens = cacheWrite;
	if (input === null && output === null && cached === null && cacheWrite === null) return null;
	return counts;
}

/** A finite number of a value, or null when the value holds none. */
function numberOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The usage of the turn that ends.
 *
 * The usage is the change of the totals between the last update before the
 * turn and the last update of the turn. The first turn has no earlier
 * update, so its usage is its own total. A field that an update does not
 * hold stays missing.
 */
function usageOfTurn(usage: CodexUsageState): Record<string, number> | null {
	const turn = usage.turn;
	if (!turn) return null;
	const result: Record<string, number> = {};
	const fields: Array<[keyof CodexTokenCounts, string]> = [
		["inputTokens", "input_tokens"],
		["outputTokens", "output_tokens"],
		["cachedInputTokens", "cache_read_input_tokens"],
		["cacheWriteInputTokens", "cache_creation_input_tokens"],
	];
	for (const [field, name] of fields) {
		const current = turn[field];
		if (current === undefined) continue;
		const earlier = usage.base?.[field];
		if (earlier === undefined) {
			result[name] = current;
			continue;
		}
		result[name] = current - earlier;
	}
	if (Object.keys(result).length === 0) return null;
	return result;
}

/** The observation of one message. */
function observation(
	message: CodexMessage,
	source: string,
	payload: Record<string, unknown>,
): BridgeObservation {
	return {
		backend: "codex",
		runId: null,
		sessionId: stringOf(message.payload.threadId),
		source,
		payload,
	};
}

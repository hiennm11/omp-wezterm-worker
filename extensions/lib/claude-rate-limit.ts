/**
 * The rate limit of a Claude Code worker.
 *
 * A Claude Code worker that hits the usage limit of its account writes one
 * row in the transcript of its session. The owner reads the tail of that
 * file and raises the event `rate_limited`.
 *
 * The run stays `running`. The event is the only effect. The owner decides
 * to cancel the worker or to wait. A newer turn resolves the event.
 */

import { type ClaudeApiError, readLastApiError, RATE_LIMIT_ERROR } from "./claude-api-error.ts";
import type { ClaudeRunState } from "./claude-run-state.ts";
import type { LifecycleDb } from "./db.ts";
import { raiseEvent } from "./event-wake.ts";
import { eventKey, resolveObsoleteEvent } from "./events.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The condition that a rate limit raises. */
export const RATE_LIMIT_CONDITION = "rate_limited";

/**
 * The decision about the rate limit of a failed turn.
 *
 * The decision is a pure function of the failed turn and the error of the
 * transcript. A test can check it without a pane and without a file.
 */
export interface RateLimitDecision {
	/** True when the error means that the account reached its limit. */
	limited: boolean;
	/** The reset time in epoch milliseconds, or null. */
	resetsAt: number | null;
	/** The kind of the limit, or null. */
	rateLimitType: string | null;
	/** The status of the API, or null. */
	apiErrorStatus: number | null;
}

/**
 * The decision about the error of a failed turn.
 *
 * The function returns no decision when the error holds no rate limit. The
 * run stays `running` then, and the owner sees no event.
 */
export function rateLimitDecision(error: ClaudeApiError | null): RateLimitDecision | null {
	if (error === null) return null;
	if (error.error !== RATE_LIMIT_ERROR) return null;
	return {
		limited: true,
		resetsAt: error.resetsAt,
		rateLimitType: error.rateLimitType,
		apiErrorStatus: error.apiErrorStatus,
	};
}

/**
 * The evidence id of the rate limit of one turn.
 *
 * The id is the id of the turn. One limit gives one event, and a replay of
 * the same turn gives no second one.
 */
function evidenceId(turnId: string | null): string {
	return `rate-limit-${turnId ?? "unknown"}`;
}

/**
 * Raise the event of a rate limit.
 *
 * The key of the event joins the run, the turn and the condition. The
 * function creates the event once, so a repeated poll raises no second one.
 */
export function recordRateLimit(
	rt: WorkerRuntime,
	runId: string,
	turnId: string | null,
	decision: RateLimitDecision,
	now: number,
): void {
	const evidence = evidenceId(turnId);
	raiseEvent(
		rt,
		{
			id: `ev-${runId}-${evidence}-${RATE_LIMIT_CONDITION}`,
			key: eventKey(runId, evidence, RATE_LIMIT_CONDITION),
			runId,
			kind: RATE_LIMIT_CONDITION,
			condition: RATE_LIMIT_CONDITION,
			payload: JSON.stringify({
				resetsAt: decision.resetsAt,
				rateLimitType: decision.rateLimitType,
				apiErrorStatus: decision.apiErrorStatus,
			}),
			actionable: true,
		},
		now,
	);
}

/**
 * Resolve the event of a rate limit.
 *
 * A worker that started a new turn went on, so the event is obsolete. The
 * history of the event stays. A run without the event writes nothing.
 */
export function resolveRateLimit(
	db: LifecycleDb,
	runId: string,
	turnId: string | null,
	now: number,
): void {
	const evidence = evidenceId(turnId);
	resolveObsoleteEvent(
		db,
		runId,
		evidence,
		RATE_LIMIT_CONDITION,
		"The worker started a new turn.",
		now,
	);
}

/**
 * Check the failed turn of a run for a rate limit.
 *
 * The function reads the tail of the transcript of the failed turn. It
 * raises the event when the error names a rate limit. The read happens once
 * per failed turn. A failed read pushes to the errors of the runtime and
 * never ends the monitor.
 *
 * A failed turn that a newer turn replaced is obsolete. The function
 * resolves its event and forgets the turn.
 */
export function checkRateLimit(rt: WorkerRuntime, runId: string, state: ClaudeRunState, now: number): void {
	const failed = state.failedTurn;
	if (failed === null) return;
	if (failed.obsolete) {
		resolveRateLimit(rt.openDb(), runId, failed.turnId, now);
		state.failedTurn = null;
		return;
	}
	if (failed.read) return;
	if (failed.transcriptPath === null) {
		failed.read = true;
		return;
	}
	failed.read = true;
	try {
		const error = readLastApiError(failed.transcriptPath);
		const decision = rateLimitDecision(error);
		if (decision === null) return;
		recordRateLimit(rt, runId, failed.turnId, decision, now);
	} catch (e) {
		/* a failed read must never end the monitor */
		rt.errors.push(e instanceof Error ? e.message : String(e));
	}
}

/**
 * The text of a rate limit for the owner.
 *
 * The text names the reset time in a plain form. It says that the run still
 * runs and that the owner decides.
 */
export function formatRateLimit(payload: string | null): string {
	const details = readPayload(payload);
	const reset =
		details.resetsAt === null ? "the reset time is unknown" : `resets at ${plainTime(details.resetsAt)}`;
	const kind = details.rateLimitType === null ? "" : ` (${details.rateLimitType})`;
	return (
		`The worker hit the usage limit of its account. The limit ${reset}${kind}. ` +
		"The run still runs. Cancel the worker or wait."
	);
}

/** The fields of the payload of a rate limit event. */
interface RateLimitPayload {
	/** The reset time in epoch milliseconds, or null. */
	resetsAt: number | null;
	/** The kind of the limit, or null. */
	rateLimitType: string | null;
}

/**
 * The fields of the payload of a rate limit event.
 *
 * A payload that is not JSON holds no time and no kind.
 */
function readPayload(payload: string | null): RateLimitPayload {
	if (payload === null) return { resetsAt: null, rateLimitType: null };
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return { resetsAt: null, rateLimitType: null };
	}
	if (typeof value !== "object" || value === null) return { resetsAt: null, rateLimitType: null };
	const record = value as Record<string, unknown>;
	const resetsAt = record.resetsAt;
	const rateLimitType = record.rateLimitType;
	return {
		resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : null,
		rateLimitType: typeof rateLimitType === "string" && rateLimitType.length > 0 ? rateLimitType : null,
	};
}

/**
 * The time of an epoch in milliseconds as a plain text.
 *
 * The function uses the local time, so the text names the time that the
 * owner reads.
 */
function plainTime(epochMs: number): string {
	const date = new Date(epochMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

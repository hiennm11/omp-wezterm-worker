/**
 * The measured usage of a native worker.
 *
 * A native CLI reports its usage in its own format. The supervisor keeps the
 * same totals as an OMP worker, so the status and the delivery read one
 * shape.
 *
 * A field that the native program does not report stays missing. The module
 * never manufactures a zero and never sums a cumulative usage twice.
 */

import type { TokenCounts, UsageTotals } from "./usage.ts";

/** The usage object that a native turn reports. */
export interface NativeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/** The totals of a native run. */
export interface NativeTotals {
	/** The sum of the counts of every turn that reported a usage. */
	turns: TokenCounts;
	/** The number of turns that reported a usage. */
	calls: number;
	/** The number of turns without a usage object. */
	callsWithoutUsage: number;
	/** The name of the model that the run used. */
	model: string | null;
	/**
	 * The time of the restart of the owner. The counts of the run start there.
	 */
	restoredAt?: number | null;
}

/** The totals of a run that reported no usage. */
export function emptyNativeTotals(): NativeTotals {
	return {
		turns: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
		calls: 0,
		callsWithoutUsage: 0,
		model: null,
	};
}

/** A finite number that is not negative, or null. */
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Add the usage of one turn into the totals.
 *
 * A turn without a usage object counts as a call without usage. The totals
 * stay partial, because the supervisor cannot prove what that turn used.
 */
export function addNativeUsage(totals: NativeTotals, usage: unknown): NativeTotals {
	if (!usage || typeof usage !== "object") {
		totals.callsWithoutUsage += 1;
		return totals;
	}
	const value = usage as NativeUsage & { model?: unknown };
	const input = count(value.input_tokens);
	const output = count(value.output_tokens);
	const cacheRead = count(value.cache_read_input_tokens);
	const cacheWrite = count(value.cache_creation_input_tokens);
	if (input === null && output === null && cacheRead === null && cacheWrite === null) {
		totals.callsWithoutUsage += 1;
		return totals;
	}
	totals.calls += 1;
	if (typeof value.model === "string" && value.model) totals.model = value.model;
	totals.turns.input += input ?? 0;
	totals.turns.output += output ?? 0;
	totals.turns.cacheRead += cacheRead ?? 0;
	totals.turns.cacheWrite += cacheWrite ?? 0;
	totals.turns.total += (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
	return totals;
}

/**
 * The totals of a native run, as the totals of an OMP worker.
 *
 * A native run has no side calls and no cost. The supervisor does not
 * invent them.
 */
export function nativeUsageTotals(totals: NativeTotals): UsageTotals {
	return {
		turns: { ...totals.turns },
		sideCalls: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
		calls: totals.calls,
		callsWithoutUsage: totals.callsWithoutUsage,
		cost: 0,
		files: 0,
	};
}

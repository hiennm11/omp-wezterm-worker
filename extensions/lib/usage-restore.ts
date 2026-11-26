/**
 * The totals of a persisted job.
 *
 * The totals come back from a JSON file, so the code checks every field. A
 * value that is not usable gives null, and the caller reads that as "no
 * baseline" and never as zero.
 */

import { count, emptyCounts, type TokenCounts, type UsageTotals } from "./usage.ts";

/** The names of the fields of one group of token counts. */
const COUNT_KEYS = Object.keys(emptyCounts()) as Array<keyof TokenCounts>;

/** True when the value holds a valid count in every field of a group. */
function validCounts(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return COUNT_KEYS.every((key) => count(record[key]) !== null);
}

/** Rebuild the totals of a persisted job, or null when the value is not usable. */
export function restoreUsageTotals(value: unknown): UsageTotals | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	if (!validCounts(entry.turns) || !validCounts(entry.sideCalls)) return null;
	// A total that was saved before the advisor group existed has no such group.
	if (entry.advisor !== undefined && !validCounts(entry.advisor)) return null;
	for (const key of ["calls", "callsWithoutUsage", "cost", "files"] as const) {
		if (count(entry[key]) === null) return null;
	}
	return {
		turns: entry.turns as TokenCounts,
		sideCalls: entry.sideCalls as TokenCounts,
		advisor: (entry.advisor as TokenCounts | undefined) ?? emptyCounts(),
		calls: entry.calls as number,
		callsWithoutUsage: entry.callsWithoutUsage as number,
		cost: entry.cost as number,
		files: entry.files as number,
	};
}

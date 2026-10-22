/**
 * The usage report of a native worker.
 *
 * A native worker reports its usage through its own bridge. The report reads
 * the native totals, so the status and the delivery show the measured
 * counts of a native run.
 *
 * A native run has no transcript of OMP, so the OMP reader finds nothing. A
 * native report never claims a zero that the native program did not report.
 */

import { readBackend } from "./backend.ts";
import type { Job } from "./job.ts";
import { type NativeTotals, nativeUsageTotals } from "./native-usage.ts";
import { combineReports, jobUsage, type UsageReport } from "./usage.ts";

/** The state of a native run that holds its usage totals. */
export interface NativeUsageHolder {
	/** The measured usage of every turn of the run. */
	usage: {
		turns: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			reasoning: number;
			total: number;
		};
		calls: number;
		callsWithoutUsage: number;
		model: string | null;
	};
}

/**
 * The usage report of a native run.
 *
 * A native run has no OMP transcript, so the report of an OMP run does not
 * apply to it. A run that reported no turn has an unknown usage. A run that
 * reported a turn without a usage object has a partial usage.
 */
export function nativeUsageReport(state: NativeUsageHolder | null): UsageReport {
	if (!state) return { state: "unknown", totals: null, cost: null, note: "the native run reported no usage" };
	const totals = nativeUsageTotals(state.usage);
	const turns = totals.calls + totals.callsWithoutUsage;
	if (turns === 0) {
		return { state: "unknown", totals: null, cost: null, note: "the native run reported no usage" };
	}
	if (totals.calls === 0) {
		return {
			state: "unknown",
			totals: null,
			cost: null,
			note: "the native run reported no usage data",
		};
	}
	if (totals.callsWithoutUsage > 0) {
		return {
			state: "partial",
			totals,
			cost: null,
			note: `${totals.callsWithoutUsage} of ${turns} model calls have no usage data`,
		};
	}
	return { state: "measured", totals, cost: null, note: "" };
}

/**
 * The usage report of a native job.
 *
 * The job holds the usage of a finished run. The run state holds the usage
 * of a running run. The job wins, because it is the durable copy.
 */
export function nativeJobUsageReport(
	job: { nativeUsage?: NativeTotals | null },
	state: NativeUsageHolder | null,
): UsageReport {
	if (job.nativeUsage) return nativeUsageReport({ usage: job.nativeUsage });
	return nativeUsageReport(state);
}

/**
 * The usage of a whole request, with the native workers in it.
 *
 * An OMP worker reports its usage through its transcript. A native worker
 * reports its usage through its bridge. The request adds both.
 */
export function requestUsageOf(
	jobs: ReadonlyMap<string, Job>,
	ids: readonly string[],
	states: ReadonlyMap<string, NativeUsageHolder>,
): UsageReport {
	const kept = ids.filter((id) => {
		const job = jobs.get(id);
		return job !== undefined && job.startedAt !== null;
	});
	const reports = kept.map((id) => {
		const job = jobs.get(id) as Job;
		if (readBackend(job) === "omp") return jobUsage(job);
		return nativeJobUsageReport(job, states.get(id) ?? null);
	});
	return combineReports(reports);
}

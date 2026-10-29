/**
 * The report of a native run.
 *
 * A native worker writes no OMP transcript. Its report lands in the same
 * file that an OMP worker writes, so a later reader finds both in one place.
 */

import type { Job } from "./job.ts";
import { appendReport } from "./report-store.ts";

/**
 * Save the report of a native run beside the run.
 *
 * The report is the evidence of the completion. A report that cannot be
 * written does not stop the run, because the file is a convenience.
 */
export function persistNativeReport(
	job: Job,
	report: { cycleId: string | null; state: string; result: string | null },
): void {
	if (report.state !== "completed") return;
	try {
		appendReport(job.sessionDir, {
			runId: job.id,
			cycleId: report.cycleId,
			state: "completed",
			result: report.result,
			dependency: null,
			resumeCondition: null,
			needs: null,
			detail: null,
		});
	} catch {
		/* the completion still holds; the file is a convenience */
	}
}

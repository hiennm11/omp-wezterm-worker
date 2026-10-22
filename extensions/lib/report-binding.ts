/**
 * The binding of a report to a run and to an instruction cycle.
 *
 * A report proves a task state only for the cycle that produced it. A report
 * of an earlier cycle cannot finish newer work. The decision is a pure
 * function of the reports and the current cycle, so a test can check it
 * without a pane.
 */

import type { WorkerReport } from "./report-model.ts";

/**
 * The report that a run may act on, or null when no report qualifies.
 *
 * A report qualifies when it names the current cycle. A report that names no
 * cycle qualifies only when the run holds one cycle, because a backend that
 * cannot name its cycle must not be able to finish a later cycle.
 */
export function boundReport(reports: WorkerReport[], currentCycleId: string | null): WorkerReport | null {
	let fallback: WorkerReport | null = null;
	for (const report of reports) {
		if (report.cycleId !== null && report.cycleId !== undefined) {
			if (currentCycleId !== null && report.cycleId === currentCycleId) return report;
			continue;
		}
		fallback = report;
	}
	if (currentCycleId === null) return fallback;
	return null;
}

/**
 * The reports of a run that belong to the current cycle.
 *
 * The decision reads these reports. A report of an earlier cycle stays in
 * the file as evidence, but it never decides the state of the run.
 */
export function reportsOfCycle(reports: WorkerReport[], currentCycleId: string | null): WorkerReport[] {
	if (currentCycleId === null) return reports.filter((report) => !report.cycleId);
	return reports.filter((report) => report.cycleId === currentCycleId);
}

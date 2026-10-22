/**
 * The report that a worker sends.
 *
 * A report is the only evidence that proves a task state. The model lives in
 * the library, so the decision functions do not depend on the tool modules.
 */

/** The state that a worker can report. */
export type ReportState = "working" | "waiting" | "needs_input" | "completed";

/** The states that the tool accepts. */
export const REPORT_STATES: ReportState[] = ["working", "waiting", "needs_input", "completed"];

/** One report. */
export interface WorkerReport {
	/** The run that produced the report. */
	runId: string;
	/**
	 * The instruction cycle that produced the report.
	 *
	 * A report of a cycle that is not the current cycle proves nothing. A
	 * backend that cannot name its cycle sends null, and the supervisor then
	 * accepts the report only when the run holds one cycle.
	 */
	cycleId?: string | null;
	/** The state that the report declares. */
	state: ReportState;
	/** The result of the task, for a completed report. */
	result: string | null;
	/** The dependency that the worker waits for, for a waiting report. */
	dependency: string | null;
	/** The condition that resumes the work, for a waiting report. */
	resumeCondition: string | null;
	/** The decision or information that the worker needs, for a needs input report. */
	needs: string | null;
	/** The detail that the worker reports about its work. */
	detail: string | null;
}

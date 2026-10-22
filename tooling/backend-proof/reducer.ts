/**
 * The reducer of the proof.
 *
 * One reducer serves both backends. It reads the native events of a run and
 * decides when a run has a valid completion report.
 *
 * The reducer holds no lifecycle logic of its own. It only records what the
 * native programs proved.
 */

/** The state of one run at the reducer. */
export interface ReducerState {
	/** The run that the reducer follows. */
	runId: string;
	/** The cycle that the native program last delivered. */
	deliveredCycleId: string | null;
	/** The instructions that the native program accepted but did not deliver. */
	pendingInput: Set<string>;
	/** The native calls that started and did not settle. */
	openExecutions: Map<string, string>;
	/** The permission requests that the native program raised and did not resolve. */
	unresolvedApprovals: Map<string, string>;
	/** The last report that passed the reducer. */
	latestReport: ValidReport | null;
	/** The instruction that the report of the latest cycle belongs to. */
	reportCycleId: string | null;
	/** The reason that the last report was refused, when it was refused. */
	rejectedReport: string | null;
}

/** A report that the reducer accepted. */
export interface ValidReport {
	/** The state that the report declares. */
	state: string;
	/** The result of the task, for a completed report. */
	result: string | null;
	/** The run that the report belongs to. */
	runId: string;
	/** The cycle that the report belongs to. */
	cycleId: string | null;
	/** The native id of the report call. */
	callId: string | null;
}

/** One native event that the reducer reads. */
export interface NativeEvent {
	/** The kind of the event. */
	kind:
		| "run-bound"
		| "instruction-accepted"
		| "instruction-delivered"
		| "cycle-terminal"
		| "execution-opened"
		| "execution-settled"
		| "approval-raised"
		| "approval-resolved"
		| "report";
	/** The native id of the event, when it has one. */
	nativeId?: string | null;
	/** The cycle that the event belongs to. */
	cycleId?: string | null;
	/** The payload of the event. */
	payload?: Record<string, unknown>;
}

/** The result of one reducer step. */
export interface ReducerStep {
	/** The state after the step. */
	state: ReducerState;
	/** The reason that the run has a valid completion report, when it has one. */
	completion: string | null;
	/** The reasons that the run has no valid completion report. */
	blockers: string[];
}

/** Create the reducer state of one run. */
export function createReducerState(runId: string): ReducerState {
	return {
		runId,
		deliveredCycleId: null,
		pendingInput: new Set(),
		openExecutions: new Map(),
		unresolvedApprovals: new Map(),
		latestReport: null,
		reportCycleId: null,
		rejectedReport: null,
	};
}

/**
 * The reason that a report is valid for a cycle.
 *
 * A report must belong to the run and to the delivered cycle. It must not
 * arrive while an instruction is pending, a call is open, or an approval is
 * unresolved.
 */
export function validateReport(
	state: ReducerState,
	report: ValidReport,
): { ok: boolean; reason: string | null } {
	if (report.runId !== state.runId) {
		return { ok: false, reason: `the report belongs to ${report.runId}, not to ${state.runId}` };
	}
	if (report.cycleId === null) return { ok: false, reason: "the report carries no cycle" };
	if (state.deliveredCycleId === null) return { ok: false, reason: "no cycle was delivered" };
	if (report.cycleId !== state.deliveredCycleId) {
		return { ok: false, reason: "the report belongs to an earlier cycle" };
	}
	if (state.pendingInput.size > 0) {
		return { ok: false, reason: "an accepted instruction is still pending" };
	}
	if (state.openExecutions.size > 0) {
		return { ok: false, reason: "a native call is still open" };
	}
	if (state.unresolvedApprovals.size > 0) {
		return { ok: false, reason: "a permission request is still unresolved" };
	}
	return { ok: true, reason: null };
}

/**
 * Apply one native event to the reducer state.
 *
 * The function is pure. It returns the new state and the reasons that the run
 * has no valid completion report.
 */
export function reduce(state: ReducerState, event: NativeEvent): ReducerStep {
	const next: ReducerState = {
		...state,
		pendingInput: new Set(state.pendingInput),
		openExecutions: new Map(state.openExecutions),
		unresolvedApprovals: new Map(state.unresolvedApprovals),
	};

	switch (event.kind) {
		case "run-bound": {
			if (event.nativeId) next.runId = event.nativeId;
			break;
		}
		case "instruction-accepted": {
			if (event.nativeId) next.pendingInput.add(event.nativeId);
			break;
		}
		case "instruction-delivered": {
			if (event.nativeId) next.pendingInput.delete(event.nativeId);
			next.deliveredCycleId = event.cycleId ?? next.deliveredCycleId;
			break;
		}
		case "execution-opened": {
			if (event.nativeId) next.openExecutions.set(event.nativeId, event.cycleId ?? "");
			break;
		}
		case "execution-settled": {
			if (event.nativeId) next.openExecutions.delete(event.nativeId);
			break;
		}
		case "approval-raised": {
			if (event.nativeId) next.unresolvedApprovals.set(event.nativeId, event.cycleId ?? "");
			break;
		}
		case "approval-resolved": {
			if (event.nativeId) next.unresolvedApprovals.delete(event.nativeId);
			break;
		}
		case "cycle-terminal": {
			if (event.cycleId && event.cycleId === next.deliveredCycleId) {
				/* the cycle ended; the report of that cycle may settle it */
			}
			break;
		}
		case "report": {
			const report = event.payload as unknown as ValidReport;
			const checked = validateReport(next, report);
			if (checked.ok) {
				next.latestReport = report;
				next.reportCycleId = report.cycleId;
			} else {
				next.rejectedReport = checked.reason;
			}
			break;
		}
	}

	const blockers: string[] = [];
	if (next.pendingInput.size > 0) blockers.push(`${next.pendingInput.size} accepted instruction(s) pending`);
	if (next.openExecutions.size > 0) blockers.push(`${next.openExecutions.size} open native call(s)`);
	if (next.unresolvedApprovals.size > 0) {
		blockers.push(`${next.unresolvedApprovals.size} unresolved permission request(s)`);
	}

	/* A report that arrived while a call was open is valid once that call
	   settles. The proof re-checks the stored report against the state now. */
	if (next.latestReport?.state === "completed" && blockers.length > 0) {
		next.rejectedReport = blockers.join(", ");
	}
	const completion =
		next.latestReport?.state === "completed" && blockers.length === 0 ? next.latestReport.result : null;

	return { state: next, completion, blockers };
}

/**
 * Clear the run-local evidence of a reducer state.
 *
 * A resumed run keeps the native history. It does not keep the reports of the
 * run that it resumes, because a report of an earlier run cannot complete it.
 */
export function clearRunEvidence(state: ReducerState): ReducerState {
	return {
		...state,
		deliveredCycleId: null,
		pendingInput: new Set(),
		openExecutions: new Map(),
		unresolvedApprovals: new Map(),
		latestReport: null,
		reportCycleId: null,
		rejectedReport: null,
	};
}

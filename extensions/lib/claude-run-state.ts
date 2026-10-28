/**
 * The state of a Claude Code run.
 *
 * The owner reads the native events of a Claude session. The events arrive
 * over the bridge. This module turns them into the state that the supervisor
 * acts on: the current cycle, the open calls, the pending instructions and
 * the open permission requests.
 *
 * The state is a plain object. The decisions that use it are pure functions,
 * so a test can check them without a pane.
 */

import type { BridgeObservation } from "./claude-bridge.ts";
import { addNativeUsage, emptyNativeTotals, type NativeTotals } from "./native-usage.ts";

/** The state of one Claude run. */
export interface ClaudeRunState {
	/** The id of the run. */
	runId: string;
	/** The native session id of the Claude session. */
	sessionId: string | null;
	/** The cycle that the native program delivered last. */
	currentCycleId: string | null;
	/** The cycles that the run already delivered, in order. */
	cycles: string[];
	/** The calls that started and did not settle. */
	openCalls: Map<string, string>;
	/** The calls that settled, with the outcome. */
	settledCalls: Map<string, { denied: boolean; isError: boolean }>;
	/** The background tasks that the run settled. */
	backgroundSettlements: number;
	/** The permission requests that no result resolved. */
	openApprovals: Map<string, string>;
	/** The permission requests that the run resolved. */
	resolvedApprovals: Map<string, string>;
	/** The instructions that the owner accepted and that no cycle carries yet. */
	pendingInstructions: Map<string, string>;
	/** The instructions that a cycle delivered. */
	deliveredInstructions: Set<string>;
	/** The reports that the worker sent, with the cycle that they name. */
	reports: Array<{ cycleId: string | null; state: string; result: string | null }>;
	/** The measured usage of every turn of the run. */
	usage: NativeTotals;
	/** The ids of the observations that the state already holds. */
	seenObservations: Set<string>;
	/** The time of the last observation, in epoch milliseconds. */
	lastActivityAt: number;
	/** The cycles whose turn ended. The usage of a turn arrives with its end. */
	completedTurns: Set<string>;
}

/** Create the state of one run. */
export function createClaudeRunState(runId: string): ClaudeRunState {
	return {
		runId,
		sessionId: null,
		currentCycleId: null,
		cycles: [],
		openCalls: new Map(),
		settledCalls: new Map(),
		backgroundSettlements: 0,
		openApprovals: new Map(),
		resolvedApprovals: new Map(),
		pendingInstructions: new Map(),
		deliveredInstructions: new Set(),
		reports: [],
		usage: emptyNativeTotals(),
		seenObservations: new Set(),
		lastActivityAt: Date.now(),
		completedTurns: new Set(),
	};
}

/**
 * Apply one observation to the state of a run.
 *
 * The function returns true when the observation changed the state. A
 * repeated observation changes nothing, so a replayed event never starts a
 * second cycle.
 */
export function applyObservation(state: ClaudeRunState, observation: BridgeObservation): boolean {
	const payload = (observation.payload ?? {}) as Record<string, unknown>;
	/* Every observation is activity. A native worker writes no OMP
	   transcript, so the supervisor reads its activity from here. */
	state.lastActivityAt = Date.now();
	switch (observation.source) {
		case "session.start": {
			state.sessionId = (payload.sessionId as string) ?? state.sessionId;
			return true;
		}
		case "turn.start": {
			const turnId = (payload.turnId as string) ?? null;
			if (!turnId) return false;
			if (state.currentCycleId === turnId) return false;
			state.currentCycleId = turnId;
			state.cycles.push(turnId);
			/* A cycle that starts carries the instruction that the owner
			   accepted. The instruction leaves the pending list, because
			   the work of that instruction now runs. */
			const instructionId = (payload.instructionId as string) ?? null;
			if (instructionId) {
				for (const [id, pending] of state.pendingInstructions) {
					if (pending === instructionId) state.pendingInstructions.delete(id);
				}
			}
			return true;
		}
		case "tool.call.opened": {
			const callId = (payload.callId as string) ?? null;
			if (!callId) return false;
			state.openCalls.set(callId, (payload.tool as string) ?? "unknown");
			return true;
		}
		case "tool.call.settled": {
			const callId = (payload.callId as string) ?? null;
			if (!callId) return false;
			state.openCalls.delete(callId);
			state.settledCalls.set(callId, {
				denied: payload.denied === true,
				isError: payload.isError === true,
			});
			state.openApprovals.delete(callId);
			return true;
		}
		case "tool.call.failed": {
			const callId = (payload.callId as string) ?? null;
			if (!callId) return false;
			/* A failed call leaves the open calls and the open approvals.
			   It records no settlement, because it returned no result. */
			state.openCalls.delete(callId);
			state.openApprovals.delete(callId);
			return true;
		}
		case "tool.check": {
			const callId = (payload.callId as string) ?? null;
			const decision = (payload.decision as string) ?? null;
			if (!callId) return false;
			if (decision === "ask") {
				state.openApprovals.set(callId, (payload.tool as string) ?? "unknown");
				return true;
			}
			if (decision === "allow" || decision === "deny") {
				state.openApprovals.delete(callId);
				state.resolvedApprovals.set(callId, decision);
				return true;
			}
			return false;
		}
		case "background.settled": {
			state.backgroundSettlements += 1;
			/* The call of a background task leaves the open calls, because the
			   task of the call ended. The row of the call stays in the
			   database, and it blocks the completion until it settles. */
			const callId = (payload.callId as string) ?? null;
			if (callId) state.openCalls.delete(callId);
			return true;
		}
		case "background.stopped": {
			/* A stop of a task ends the call that started it. The call id
			   arrives with the stop only when the host names it. */
			const callId = (payload.callId as string) ?? null;
			if (callId) state.openCalls.delete(callId);
			return true;
		}
		case "command.accepted": {
			const id = (payload.id as string) ?? null;
			const instructionId = (payload.instructionId as string) ?? null;
			if (!id || !instructionId) return false;
			state.pendingInstructions.set(id, instructionId);
			return true;
		}
		case "instruction.delivered": {
			state.deliveredInstructions.add((payload.uuid as string) ?? "");
			/* The delivery of an instruction ends its wait. The
			   instruction leaves the pending list. */
			const instructionId = (payload.instructionId as string) ?? null;
			if (instructionId) {
				for (const [id, pending] of state.pendingInstructions) {
					if (pending === instructionId) state.pendingInstructions.delete(id);
				}
			}
			return true;
		}
		case "report": {
			state.reports.push({
				cycleId: (payload.cycleId as string) ?? null,
				state: (payload.state as string) ?? "unknown",
				result: (payload.result as string) ?? null,
			});
			return true;
		}
		case "turn.complete": {
			/* The usage of the turn joins the totals of the run. A turn
			   without a usage object counts as a call without usage, so the
			   totals stay partial instead of claiming a zero. */
			addNativeUsage(state.usage, payload.usage ?? null);
			const turnId = payload.turnId;
			if (typeof turnId === "string") state.completedTurns.add(turnId);
			return true;
		}
		default:
			return false;
	}
}

/**
 * The reason that a run cannot finish, or null when it can.
 *
 * A pending instruction blocks it, because the worker still owes a cycle.
 * An open permission request blocks it, because the person still owns a
 * decision. An open call blocks it, because the work still runs.
 *
 * A turn that has not ended blocks it too. The native program reports the
 * usage of a turn with its end, so a run that ends before its turn ends
 * loses the measured usage.
 */
export function claudeCompletionBlocker(state: ClaudeRunState): string | null {
	if (state.pendingInstructions.size > 0) {
		return `${state.pendingInstructions.size} accepted instruction(s) wait for their cycle.`;
	}
	if (state.openApprovals.size > 0) {
		return `${state.openApprovals.size} permission request(s) wait for the person.`;
	}
	if (state.openCalls.size > 0) {
		return `${state.openCalls.size} call(s) have not settled.`;
	}
	if (state.currentCycleId !== null && !state.completedTurns.has(state.currentCycleId)) {
		return "the turn of the current cycle has not ended yet.";
	}
	return null;
}

/**
 * The report that the run may act on, or null when it has none.
 *
 * A report qualifies only for the current cycle. A report of an earlier
 * cycle proves nothing about the work that runs now.
 */
export function claudeBoundReport(
	state: ClaudeRunState,
): { cycleId: string | null; state: string; result: string | null } | null {
	let found: { cycleId: string | null; state: string; result: string | null } | null = null;
	for (const report of state.reports) {
		if (report.cycleId !== null && report.cycleId === state.currentCycleId) return report;
		if (report.cycleId === null) found = report;
	}
	return found;
}

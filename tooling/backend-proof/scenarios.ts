/**
 * The scenarios of the proof.
 *
 * One module holds the scenarios of both backends. Each backend supplies the
 * actions of a scenario, and the module runs the shared reducer against the
 * observations that the backend produced.
 *
 * A scenario passes only when its own contract holds. One successful read
 * does not prove the approvals, the queued input, the recovery or the stop.
 */

import type { EvidenceStore, Verdict } from "./evidence.ts";
import type { CommandResult, ProofListener } from "./listener.ts";
import { createReducerState, type NativeEvent, type ReducerState, reduce } from "./reducer.ts";

/** The result of one scenario. */
export interface ScenarioOutcome {
	/** The name of the scenario. */
	scenario: string;
	/** The result of the scenario. */
	verdict: Verdict;
	/** The reason of the result. */
	detail: string;
}

/** The actions that one backend provides for a scenario. */
export interface ScenarioActions {
	/** The action that the scenario runs. */
	run: (context: ScenarioContext) => Promise<ScenarioOutcome>;
}

/** The context that a scenario runs in. */
export interface ScenarioContext {
	/** The evidence store of the proof run. */
	evidence: EvidenceStore;
	/** The listener of the proof run. */
	listener: ProofListener;
	/** The proof run id. */
	runId: string;
	/** The scenario that runs. */
	scenario: string;
	/** The reducer state of the run. */
	state: ReducerState;
	/** The native events that the reducer read. */
	events: NativeEvent[];
}

/**
 * Feed the observations of a run into the reducer.
 *
 * The function reads the observations that the listener received. It never
 * guesses a transition from silence.
 */
export function feedObservations(
	state: ReducerState,
	observations: Array<{ source: string; payload: unknown }>,
): { state: ReducerState; events: NativeEvent[]; blockers: string[] } {
	let current = state;
	const events: NativeEvent[] = [];
	let blockers: string[] = [];

	for (const observation of observations) {
		const event = toNativeEvent(observation);
		if (!event) continue;
		const step = reduce(current, event);
		current = step.state;
		events.push(event);
		blockers = step.blockers;
	}
	return { state: current, events, blockers };
}

/** The native event that an observation carries, or null when it carries none. */
export function toNativeEvent(observation: { source: string; payload: unknown }): NativeEvent | null {
	const payload = (observation.payload ?? {}) as Record<string, unknown>;
	const source = observation.source;

	if (source === "session.start") {
		const proofRunId = (payload.proofRunId as string) ?? null;
		if (!proofRunId) return null;
		return { kind: "run-bound", nativeId: proofRunId, cycleId: null, payload };
	}
	if (source === "command.accepted") {
		return {
			kind: "instruction-accepted",
			nativeId: (payload.instructionId as string) ?? null,
			cycleId: (payload.cycleId as string) ?? null,
			payload,
		};
	}
	if (source === "prompt.submit.accepted" || source === "instruction.delivered") {
		return {
			kind: "instruction-delivered",
			nativeId: (payload.instructionId as string) ?? null,
			cycleId: (payload.turnId as string) ?? null,
			payload,
		};
	}
	if (source === "turn.start") {
		return {
			kind: "instruction-delivered",
			nativeId: (payload.instructionId as string) ?? null,
			cycleId: (payload.turnId as string) ?? null,
			payload,
		};
	}
	if (source === "turn.complete") {
		return { kind: "cycle-terminal", cycleId: (payload.turnId as string) ?? null, payload };
	}
	if (source === "tool.call.opened" || source === "item.started") {
		const tool = (payload.tool as string) ?? "";
		/* The report tool settles the report. Its own call must not block it. */
		if (tool.includes("wezterm_worker_report")) return null;
		return {
			kind: "execution-opened",
			nativeId: (payload.callId as string) ?? (payload.itemId as string) ?? null,
			cycleId: (payload.turnId as string) ?? null,
			payload,
		};
	}
	if (source === "tool.call.settled" || source === "item.completed") {
		const tool = (payload.tool as string) ?? "";
		if (tool.includes("wezterm_worker_report")) return null;
		return {
			kind: "execution-settled",
			nativeId: (payload.callId as string) ?? (payload.itemId as string) ?? null,
			cycleId: (payload.turnId as string) ?? null,
			payload,
		};
	}
	if (source === "approval.requested") {
		return {
			kind: "approval-raised",
			nativeId: (payload.requestId as string) ?? (payload.callId as string) ?? null,
			cycleId: (payload.turnId as string) ?? null,
			payload,
		};
	}
	if (source === "approval.resolved") {
		return {
			kind: "approval-resolved",
			nativeId: (payload.requestId as string) ?? (payload.callId as string) ?? null,
			cycleId: (payload.turnId as string) ?? null,
			payload,
		};
	}
	if (source === "tool.check") {
		/* The native decision of the permission path. A decision of "ask"
		   means that the session waits for the person. */
		const decision = (payload.decision as string) ?? null;
		const callId = (payload.callId as string) ?? null;
		if (decision === "ask" && callId) {
			return { kind: "approval-raised", nativeId: callId, cycleId: null, payload };
		}
		if (decision === "allow" && callId) {
			return { kind: "approval-resolved", nativeId: callId, cycleId: null, payload };
		}
		if (decision === "deny" && callId) {
			return { kind: "approval-resolved", nativeId: callId, cycleId: null, payload };
		}
		return null;
	}
	if (source === "report") {
		return { kind: "report", payload: payload as never };
	}
	return null;
}

/** The command results that carry a phase. */
export function resultsByPhase(results: CommandResult[], phase: CommandResult["phase"]): CommandResult[] {
	return results.filter((result) => result.phase === phase);
}

/** The reducer state of one run. */
export function newState(runId: string): ReducerState {
	return createReducerState(runId);
}

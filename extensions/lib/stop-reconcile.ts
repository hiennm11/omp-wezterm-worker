/**
 * The reconciliation of the stop intents that a restart left pending.
 *
 * A stop intent is stored before the pane of a worker closes. A command that
 * ran cannot be taken back, so a recovered owner reads the pane state and
 * settles the intent. The code never guesses: an unreadable pane list keeps
 * the intent pending.
 *
 * The module reads the intents of the runs that this session owns. An intent
 * of another session stays untouched.
 */

import type { LifecycleDb } from "./db.ts";
import type { Job } from "./job.ts";
import { generationOf } from "./owner.ts";
import { type PaneState, paneStatesOf } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";
import {
	confirmStopIntent,
	failStopIntent,
	pendingStopIntents,
	type StopIntent,
	stopIntentsOfRun,
} from "./stop-intent.ts";

/** The decision that the pane state produces. */
export type IntentVerdict = "confirm" | "fail" | "keep";

/** The ids of the intents that the reconciliation settled. */
export interface ReconcileOutcome {
	/** The intents whose pane is gone. */
	confirmed: string[];
	/** The intents whose pane still exists. */
	failed: string[];
	/** The intents that the pane list could not settle. */
	kept: string[];
}

/**
 * The decision that a pane state produces.
 *
 * A pane that is gone proves that the command ran. A pane that still exists
 * proves that the command did not close it. An unreadable pane list proves
 * nothing, so the intent stays pending.
 */
export function intentVerdict(pane: PaneState): IntentVerdict {
	if (pane === "gone") return "confirm";
	if (pane === "present") return "fail";
	return "keep";
}

/**
 * Settle the stop intents that a restart left pending.
 *
 * The function reads the pane list one time. It handles the intents of the
 * runs that this session owns. A run without a pane counts as gone. An
 * intent of another session and an intent of an unknown run stay untouched.
 */
export async function reconcileStopIntents(
	rt: WorkerRuntime,
	jobs: Job[],
	now: number,
): Promise<ReconcileOutcome> {
	const outcome: ReconcileOutcome = { confirmed: [], failed: [], kept: [] };
	const db = rt.openDb();
	const intents = pendingStopIntents(db);
	if (intents.length === 0) return outcome;

	const byId = new Map(jobs.map((job) => [job.id, job]));
	const owned: { id: string; job: Job }[] = [];
	for (const intent of intents) {
		const job = byId.get(intent.runId);
		if (!job) continue;
		if (generationOf(rt, intent.runId) === null) continue;
		owned.push({ id: intent.id, job });
	}
	if (owned.length === 0) return outcome;

	const paneIds = [...new Set(owned.map((entry) => entry.job.paneId).filter((id): id is number => id !== null))];
	const states = paneIds.length > 0 ? await paneStatesOf(rt, paneIds) : new Map<number, PaneState>();

	for (const entry of owned) {
		const paneId = entry.job.paneId;
		const state: PaneState = paneId === null ? "gone" : (states.get(paneId) ?? "unknown");
		const verdict = intentVerdict(state);
		if (verdict === "confirm") {
			confirmStopIntent(db, entry.id, now);
			outcome.confirmed.push(entry.id);
		} else if (verdict === "fail") {
			failStopIntent(db, entry.id, now);
			outcome.failed.push(entry.id);
		} else {
			outcome.kept.push(entry.id);
		}
	}
	return outcome;
}

/**
 * The pending stop intent of one run, or null when it has none.
 */
export function pendingStopIntentOf(db: LifecycleDb, runId: string): StopIntent | null {
	return stopIntentsOfRun(db, runId).find((intent) => intent.state === "pending") ?? null;
}

/**
 * The reason that a control action must not go on, or null when it may go on.
 *
 * A pending stop intent means that a destructive command may have run. The
 * text names the worker and the tool that retries the stop.
 */
export function stopIntentRefusal(db: LifecycleDb, runId: string): string | null {
	if (!pendingStopIntentOf(db, runId)) return null;
	return (
		`Worker ${runId} has a pending stop intent. The pane of the worker may already be closed. ` +
		"Call wezterm_worker_cancel to settle the stop before you act on the worker."
	);
}

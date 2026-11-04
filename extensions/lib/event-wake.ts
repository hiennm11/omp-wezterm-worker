/**
 * The wake of the main session for an actionable event.
 *
 * A monitor writes an event into the database. The main session learns of the
 * event only when it calls the status tool. The wake puts the event into the
 * session as a user message and starts a turn, so the owner acts on the event
 * at once.
 *
 * The wake uses the channel of the delivery of a result:
 * `pi.sendUserMessage(text, { triggerTurn: true })`. See docs/adr/0004.
 *
 * The wake happens once per event. The delivery row of the event holds the
 * state `sent`, so a later poll and a later restart send no second message.
 * The event stays in the list of the pending events, so it still blocks the
 * cleanup until the owner handles it.
 */

import type { LifecycleDb } from "./db.ts";
import { beginDelivery, deliveriesOfEvent, markSent, markUncertain } from "./delivery.ts";
import { createEvent, type EventCondition, pendingEvents, type WorkerEvent } from "./events.ts";
import { generationOf } from "./owner.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { writeUnderAuthority } from "./write-authority.ts";

/** The event that a caller raises. */
export interface NewEvent {
	/** The id of the event. */
	id: string;
	/** The key that makes the event unique. */
	key: string;
	/** The run that the event belongs to. */
	runId: string;
	/** The kind of the event. */
	kind: string;
	/** The condition that made the event. */
	condition: EventCondition;
	/** The details of the event. */
	payload: string | null;
	/** True when the owner can act on the event. */
	actionable: boolean;
}

/** The worker that an event names. */
export interface EventWorker {
	/** The id of the worker. */
	id: string;
	/** The label of the worker. */
	label: string;
	/** The time when the run of the worker started. */
	startedAt: number;
}

/**
 * The conditions that never wake the main session.
 *
 * A result has its own delivery. An execution loss comes with the stop of the
 * worker, and the stop path notifies the owner already.
 */
const SILENT_CONDITIONS: EventCondition[] = ["result", "execution_loss"];

/**
 * The worker that a run names.
 *
 * A run that this session does not know names itself. The label of such a
 * worker is the id of the run.
 */
export function workerFor(rt: WorkerRuntime, runId: string, now: number): EventWorker {
	const job = rt.jobs.get(runId);
	if (!job) return { id: runId, label: runId, startedAt: now };
	return { id: job.id, label: job.label, startedAt: job.startedAt ?? job.createdAt };
}

/**
 * True when an event must wake the main session.
 *
 * An event that nobody can act on wakes nobody.
 */
export function wakesMainSession(event: WorkerEvent): boolean {
	if (!event.actionable) return false;
	return !SILENT_CONDITIONS.includes(event.condition);
}

/**
 * The text of a wake.
 *
 * The text names the worker, the condition, the run time and the event id. It
 * names the tools that the owner can use. It holds no result text, and it
 * never tells the worker to continue.
 */
export function formatWake(event: WorkerEvent, worker: EventWorker, now: number): string {
	const seconds = Math.max(0, Math.round((now - worker.startedAt) / 1000));
	return [
		`Worker ${worker.id} (${worker.label}) needs your attention.`,
		`The condition is ${event.condition}. The run time is ${seconds} seconds. The event id is ${event.id}.`,
		"Read the worker with wezterm_worker_peek.",
		"Steer the worker with wezterm_worker_steer.",
		"Record the handling with wezterm_worker_ack.",
	].join("\n");
}

/**
 * Record an event and report whether the event was created.
 *
 * The caller that needs the event and another write in one transaction uses
 * this function. The wake then runs after the transaction, so no message
 * goes out while a transaction is open.
 */
export function recordEvent(
	db: LifecycleDb,
	event: NewEvent,
	now: number,
): { event: WorkerEvent; created: boolean } {
	return createEvent(
		db,
		event.id,
		event.key,
		event.runId,
		event.kind,
		event.condition,
		event.payload,
		event.actionable,
		now,
	);
}

/**
 * Raise an event and wake the main session when the event is actionable.
 *
 * The event is created once. A repeated call finds the event that exists and
 * wakes nobody.
 */
export function raiseEvent(rt: WorkerRuntime, event: NewEvent, now: number): WorkerEvent {
	const created = recordEvent(rt.openDb(), event, now);
	wakeCreated(rt, created, now);
	return created.event;
}

/**
 * Wake the main session for a new event.
 *
 * A caller that writes the event in one transaction with another row uses
 * this function. The wake runs after the transaction, so no message goes out
 * while a transaction is open.
 */
export function wakeCreated(
	rt: WorkerRuntime,
	created: { event: WorkerEvent; created: boolean },
	now: number,
): void {
	if (!created.created) return;
	wakeEvent(rt, created.event, workerFor(rt, created.event.runId ?? "", now), now);
}

/**
 * Wake the main session for one event.
 *
 * Only the owner of the task of the event may wake the session. The attempt
 * is recorded before the message goes out, and the key of the attempt is the
 * id of the event. A run id would mark the result of the run as sent.
 */
export function wakeEvent(rt: WorkerRuntime, event: WorkerEvent, worker: EventWorker, now: number): boolean {
	if (!wakesMainSession(event)) return false;
	const db = rt.openDb();
	if (hasSentDelivery(db, event.id)) return false;
	const attempt = writeUnderAuthority(db, rt.sessionId, worker.id, () =>
		beginDelivery(db, event.id, event.id, generationOf(rt, worker.id) ?? 0, now),
	);
	if (attempt.refused) {
		rt.errors.push(`The wake for the event ${event.id} was refused: ${attempt.refusal}`);
		return false;
	}
	try {
		const channel = rt.sendToMainSession(formatWake(event, worker, now));
		// A runtime without a host has no channel. The attempt stays
		// unsettled, and a later startup sends the message again.
		if (channel === "none") return false;
		markSent(db, event.id, channel, Date.now());
		return true;
	} catch (e) {
		markUncertain(db, event.id, e instanceof Error ? e.message : String(e), Date.now());
		rt.errors.push(
			`The wake for the event ${event.id} failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}
}

/**
 * True when a message for the given key already reached the main session.
 */
export function hasSentDelivery(db: LifecycleDb, key: string): boolean {
	return deliveriesOfEvent(db, key).some((attempt) => attempt.state === "sent");
}

/**
 * Wake the main session for the events that no owner handled.
 *
 * A restart can lose the wake of an event. The replay sends the message again
 * for every event that this session owns, that nobody handled, and that never
 * reached the main session.
 *
 * The events of a run that ended and delivered its result stay out. The
 * owner knows that run already.
 */
export function replayEvents(rt: WorkerRuntime, now: number): WorkerEvent[] {
	const db = rt.openDb();
	const woken: WorkerEvent[] = [];
	for (const event of pendingEvents(db)) {
		const runId = event.runId;
		if (runId === null) continue;
		// The session owns the task of the event.
		if (generationOf(rt, runId) === null) continue;
		// The run ended and delivered its result. The owner knows the run.
		if (hasSentDelivery(db, runId)) continue;
		// The event reached the main session already.
		if (hasSentDelivery(db, event.id)) continue;
		if (wakeEvent(rt, event, workerFor(rt, runId, now), now)) woken.push(event);
	}
	return woken;
}

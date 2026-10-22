/**
 * The worker events and their handling.
 *
 * One event keeps one identity through every replay. A recovery must not
 * create a second event for the same condition. The owner records a
 * disposition for the event.
 */

import type { LifecycleDb } from "./db.ts";

/** The condition that made an event. */
export type EventCondition =
	| "result"
	| "needs_input"
	| "missing_report"
	| "idle_after_working"
	| "execution_loss"
	| "unresolved_launch"
	| "unknown_outcome"
	| "permission_request";

/** One worker event. */
export interface WorkerEvent {
	id: string;
	runId: string | null;
	kind: string;
	condition: EventCondition;
	payload: string | null;
	actionable: boolean;
	createdAt: number;
}

/** The disposition that the owner recorded for an event. */
export type Disposition = "accepted" | "follow_up" | "discarded";

/** The record of how the owner handled an event. */
export interface EventHandling {
	eventId: string;
	disposition: Disposition;
	note: string | null;
	ownerId: string | null;
	ownerGeneration: number | null;
	createdAt: number;
}

/**
 * The key that makes one event per condition.
 *
 * The key joins the run, the evidence that started the cycle, and the
 * condition. A recovery that sees the same key finds the event that exists.
 */
export function eventKey(runId: string, evidenceId: string, condition: EventCondition): string {
	return `${runId}|${evidenceId}|${condition}`;
}

/**
 * Create one event, or return the event that already exists.
 *
 * The key is the identity of the event. A second call with the same key does
 * not create a second event.
 */
export function createEvent(
	db: LifecycleDb,
	id: string,
	key: string,
	runId: string | null,
	kind: string,
	condition: EventCondition,
	payload: string | null,
	actionable: boolean,
	now: number,
): { event: WorkerEvent; created: boolean } {
	return db.write(() => {
		const existing = findEventByKey(db, key);
		if (existing) return { event: existing, created: false };
		db.handle
			.prepare(
				`INSERT INTO events (id, run_id, kind, condition, payload, actionable, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, runId, kind, condition, payload, actionable ? 1 : 0, now);
		db.handle.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`event_key:${key}`, id);
		return {
			event: { id, runId, kind, condition, payload, actionable, createdAt: now },
			created: true,
		};
	});
}

/** The event of one key, or null. */
export function findEventByKey(db: LifecycleDb, key: string): WorkerEvent | null {
	const row = db.handle.prepare("SELECT value FROM meta WHERE key = ?").get(`event_key:${key}`) as
		| { value: string }
		| undefined;
	if (!row) return null;
	return readEvent(db, row.value);
}

/** Read one event, or null when the id is unknown. */
export function readEvent(db: LifecycleDb, id: string): WorkerEvent | null {
	const row = db.handle
		.prepare("SELECT id, run_id, kind, condition, payload, actionable, created_at FROM events WHERE id = ?")
		.get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		id: String(row.id),
		runId: row.run_id === null ? null : String(row.run_id),
		kind: String(row.kind),
		condition: String(row.condition) as EventCondition,
		payload: row.payload === null ? null : String(row.payload),
		actionable: Number(row.actionable) !== 0,
		createdAt: Number(row.created_at),
	};
}

/** The events of one run. */
export function eventsOfRun(db: LifecycleDb, runId: string): WorkerEvent[] {
	const rows = db.handle
		.prepare(
			"SELECT id, run_id, kind, condition, payload, actionable, created_at FROM events WHERE run_id = ? ORDER BY created_at",
		)
		.all(runId) as Record<string, unknown>[];
	return rows.map(toEvent);
}

/**
 * The events that no owner handled yet.
 *
 * A cleanup checks this list. A pending actionable event blocks the cleanup.
 */
export function pendingEvents(db: LifecycleDb): WorkerEvent[] {
	const rows = db.handle
		.prepare(
			`SELECT e.id, e.run_id, e.kind, e.condition, e.payload, e.actionable, e.created_at
			 FROM events e
			 LEFT JOIN event_handling h ON h.event_id = e.id
			 WHERE h.event_id IS NULL AND e.actionable = 1
			 ORDER BY e.created_at`,
		)
		.all() as Record<string, unknown>[];
	return rows.map(toEvent);
}

/** The handling of one event, or null when the owner did not handle it. */
export function readHandling(db: LifecycleDb, eventId: string): EventHandling | null {
	const row = db.handle
		.prepare(
			"SELECT event_id, disposition, note, owner_id, owner_generation, created_at FROM event_handling WHERE event_id = ?",
		)
		.get(eventId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		eventId: String(row.event_id),
		disposition: String(row.disposition) as Disposition,
		note: row.note === null ? null : String(row.note),
		ownerId: row.owner_id === null ? null : String(row.owner_id),
		ownerGeneration: row.owner_generation === null ? null : Number(row.owner_generation),
		createdAt: Number(row.created_at),
	};
}

/**
 * Record the handling of an event.
 *
 * The same disposition twice succeeds without another effect. A different
 * disposition is refused and returns the disposition that exists.
 */
export function recordHandling(
	db: LifecycleDb,
	eventId: string,
	disposition: Disposition,
	note: string | null,
	ownerId: string | null,
	ownerGeneration: number | null,
	now: number,
): { ok: true; handling: EventHandling } | { ok: false; reason: string; existing: EventHandling } {
	return db.write(() => {
		const existing = readHandling(db, eventId);
		if (existing) {
			if (existing.disposition === disposition) return { ok: true, handling: existing };
			return {
				ok: false,
				reason: `The event was already handled as ${existing.disposition}.`,
				existing,
			};
		}
		db.handle
			.prepare(
				`INSERT INTO event_handling (event_id, disposition, note, owner_id, owner_generation, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(eventId, disposition, note, ownerId, ownerGeneration, now);
		return {
			ok: true,
			handling: { eventId, disposition, note, ownerId, ownerGeneration, createdAt: now },
		};
	});
}

/**
 * Resolve the obsolete event of a condition for one cycle.
 *
 * A later valid report resolves an event that the condition created. The
 * history of the event stays. The function returns the event that it
 * resolved, or null when there was none.
 */
export function resolveObsoleteEvent(
	db: LifecycleDb,
	runId: string,
	evidenceId: string,
	condition: EventCondition,
	note: string,
	now: number,
): WorkerEvent | null {
	const key = eventKey(runId, evidenceId, condition);
	return db.write(() => {
		const event = findEventByKey(db, key);
		if (!event) return null;
		if (readHandling(db, event.id)) return event;
		db.handle
			.prepare(
				`INSERT INTO event_handling (event_id, disposition, note, owner_id, owner_generation, created_at)
				 VALUES (?, 'accepted', ?, NULL, NULL, ?)
				 ON CONFLICT(event_id) DO NOTHING`,
			)
			.run(event.id, note, now);
		return event;
	});
}

/** Build an event from a database row. */
export function toEvent(row: Record<string, unknown>): WorkerEvent {
	return {
		id: String(row.id),
		runId: row.run_id === null ? null : String(row.run_id),
		kind: String(row.kind),
		condition: String(row.condition) as EventCondition,
		payload: row.payload === null ? null : String(row.payload),
		actionable: Number(row.actionable) !== 0,
		createdAt: Number(row.created_at),
	};
}

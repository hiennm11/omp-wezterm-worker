/**
 * The delivery attempts of a pending event.
 *
 * A delivery attempt keeps the event identity and the owner generation. An
 * attempt that settled and an attempt of uncertain outcome stay distinct from
 * a handling acknowledgement.
 */

import type { LifecycleDb } from "./db.ts";

/**
 * The state of a delivery attempt.
 *
 * The pending state means that the attempt started.
 * The sent state means that the message reached the host.
 * The uncertain state means that the host did not confirm the send.
 */
export type DeliveryState = "pending" | "sent" | "uncertain";

/** One delivery attempt. */
export interface DeliveryAttempt {
	id: string;
	eventId: string;
	generation: number;
	state: DeliveryState;
	detail: string | null;
	createdAt: number;
	updatedAt: number;
}

const INSERT =
	"INSERT INTO deliveries (id, event_id, generation, state, detail, created_at, updated_at) " +
	"VALUES (?, ?, ?, 'pending', NULL, ?, ?) " +
	"ON CONFLICT(id) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at";

const SELECT = "SELECT id, event_id, generation, state, detail, created_at, updated_at FROM deliveries";

/**
 * Record a delivery attempt before the message goes out.
 *
 * The write happens first. A crash after the send leaves a pending attempt,
 * and the recovery replays it under the same event id.
 */
export function beginDelivery(
	db: LifecycleDb,
	id: string,
	eventId: string,
	generation: number,
	now: number,
): DeliveryAttempt {
	return db.write(() => {
		db.handle.prepare(INSERT).run(id, eventId, generation, now, now);
		return {
			id,
			eventId,
			generation,
			state: "pending" as const,
			detail: null,
			createdAt: now,
			updatedAt: now,
		};
	});
}

/** Move a delivery attempt to the sent state. */
export function markSent(db: LifecycleDb, id: string, detail: string | null, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE deliveries SET state = 'sent', detail = ?, updated_at = ? WHERE id = ?")
			.run(detail, now, id);
	});
}

/** Move a delivery attempt to the uncertain state. */
export function markUncertain(db: LifecycleDb, id: string, detail: string | null, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE deliveries SET state = 'uncertain', detail = ?, updated_at = ? WHERE id = ?")
			.run(detail, now, id);
	});
}

/** The delivery attempts of one event. */
export function deliveriesOfEvent(db: LifecycleDb, eventId: string): DeliveryAttempt[] {
	const rows = db.handle.prepare(`${SELECT} WHERE event_id = ? ORDER BY created_at`).all(eventId) as Record<
		string,
		unknown
	>[];
	return rows.map(toAttempt);
}

/**
 * The delivery attempts that did not settle.
 *
 * A pending or uncertain attempt means that the event may still need a
 * replay.
 */
export function unsettledDeliveries(db: LifecycleDb): DeliveryAttempt[] {
	const rows = db.handle
		.prepare(`${SELECT} WHERE state IN ('pending', 'uncertain') ORDER BY created_at`)
		.all() as Record<string, unknown>[];
	return rows.map(toAttempt);
}

/** Build a delivery attempt from a database row. */
function toAttempt(row: Record<string, unknown>): DeliveryAttempt {
	return {
		id: String(row.id),
		eventId: String(row.event_id),
		generation: Number(row.generation),
		state: String(row.state) as DeliveryState,
		detail: row.detail === null ? null : String(row.detail),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

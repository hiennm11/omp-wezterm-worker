/**
 * The owner resolution of an unknown task outcome.
 *
 * The resolution lets the owner settle an unknown outcome. It never creates
 * an explicit worker completion report. The evidence note says what the owner
 * actually confirmed.
 */

import type { LifecycleDb } from "./db.ts";

/** The resolution that the owner recorded for an unknown outcome. */
export type OwnerResolution = "recorded_result" | "incomplete" | "abandoned";

/** One owner resolution. */
export interface ResolutionRecord {
	id: string;
	eventId: string;
	runId: string | null;
	resolution: OwnerResolution;
	evidenceNote: string;
	ownerId: string | null;
	ownerGeneration: number | null;
	createdAt: number;
}

/**
 * The reason a resolution was refused, or null when it was recorded.
 */
export type ResolutionOutcome = { ok: true; resolution: ResolutionRecord } | { ok: false; reason: string };

/** The resolutions that the tool accepts. */
export const RESOLUTIONS: OwnerResolution[] = ["recorded_result", "incomplete", "abandoned"];

/**
 * Record the owner resolution of an unknown outcome.
 *
 * The resolution and the event disposition are written in one transaction.
 * The same resolution twice succeeds. A different resolution is refused.
 */
export function recordResolution(
	db: LifecycleDb,
	id: string,
	eventId: string,
	runId: string | null,
	resolution: OwnerResolution,
	evidenceNote: string,
	ownerId: string | null,
	ownerGeneration: number | null,
	now: number,
): ResolutionOutcome {
	return db.write(() => {
		const existing = db.handle
			.prepare(
				"SELECT id, event_id, run_id, resolution, evidence_note, owner_id, owner_generation, created_at FROM owner_resolutions WHERE event_id = ?",
			)
			.get(eventId) as Record<string, unknown> | undefined;
		if (existing) {
			if (String(existing.resolution) === resolution) {
				return { ok: true, resolution: toResolution(existing) };
			}
			return {
				ok: false,
				reason: `The event was already resolved as ${String(existing.resolution)}.`,
			};
		}
		db.handle
			.prepare(
				`INSERT INTO owner_resolutions (id, event_id, run_id, resolution, evidence_note, owner_id, owner_generation, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, eventId, runId, resolution, evidenceNote, ownerId, ownerGeneration, now);
		// A resolution closes the obligation of the owner. The event stays in
		// the history. The owner resolution is not a worker completion report.
		db.handle
			.prepare(
				`INSERT INTO event_handling (event_id, disposition, note, owner_id, owner_generation, created_at)
				 VALUES (?, 'accepted', ?, ?, ?, ?)
				 ON CONFLICT(event_id) DO NOTHING`,
			)
			.run(eventId, evidenceNote, ownerId, ownerGeneration, now);
		const row = db.handle
			.prepare(
				"SELECT id, event_id, run_id, resolution, evidence_note, owner_id, owner_generation, created_at FROM owner_resolutions WHERE id = ?",
			)
			.get(id) as Record<string, unknown>;
		return { ok: true, resolution: toResolution(row) };
	});
}

/** The resolution of one event, or null. */
export function readResolution(db: LifecycleDb, eventId: string): ResolutionRecord | null {
	const row = db.handle
		.prepare(
			"SELECT id, event_id, run_id, resolution, evidence_note, owner_id, owner_generation, created_at FROM owner_resolutions WHERE event_id = ?",
		)
		.get(eventId) as Record<string, unknown> | undefined;
	return row ? toResolution(row) : null;
}

/** The resolutions of one run. */
export function resolutionsOfRun(db: LifecycleDb, runId: string): ResolutionRecord[] {
	const rows = db.handle
		.prepare(
			"SELECT id, event_id, run_id, resolution, evidence_note, owner_id, owner_generation, created_at FROM owner_resolutions WHERE run_id = ? ORDER BY created_at",
		)
		.all(runId) as Record<string, unknown>[];
	return rows.map(toResolution);
}

/** Build a resolution from a database row. */
function toResolution(row: Record<string, unknown>): ResolutionRecord {
	return {
		id: String(row.id),
		eventId: String(row.event_id),
		runId: row.run_id === null ? null : String(row.run_id),
		resolution: String(row.resolution) as OwnerResolution,
		evidenceNote: String(row.evidence_note),
		ownerId: row.owner_id === null ? null : String(row.owner_id),
		ownerGeneration: row.owner_generation === null ? null : Number(row.owner_generation),
		createdAt: Number(row.created_at),
	};
}

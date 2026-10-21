/**
 * The one-time migration of the old registry.
 *
 * The registry was a JSON file. The database replaces it. The migration runs
 * once, inside one transaction. The source file stays on disk as evidence.
 */

import { readFileSync } from "node:fs";
import type { LifecycleDb } from "./db.ts";
import { SCHEMA_VERSION } from "./db.ts";
import type { Job } from "./job.ts";

/** The old registry file inside the state directory. */
export function legacyRegistryFile(stateDir: string): string {
	return `${stateDir}/registry.json`;
}

/** The shape of the old registry file. */
interface LegacyRegistry {
	version?: number;
	jobs?: unknown[];
}

/**
 * The reason the migration did not run, or null when it ran.
 */
export type MigrationFailure =
	| { kind: "malformed"; detail: string }
	| { kind: "alreadyDone" }
	| { kind: "noSource" };

/** The result of a migration run. */
export interface MigrationResult {
	/** True when the migration ran in this call. */
	migrated: boolean;
	/** The number of runs that the migration wrote. */
	runs: number;
	/** The reason the migration did not run, when it did not run. */
	failure: MigrationFailure | null;
}

/**
 * Read the old registry file.
 *
 * A file that does not exist is not a failure. A file that exists and does
 * not parse is a failure. The caller must not replace or delete it.
 */
export function readLegacyRegistry(file: string): { jobs: Job[] } | { error: string } {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { jobs: [] };
		return { error: `cannot read the registry file: ${String(e)}` };
	}
	let parsed: LegacyRegistry;
	try {
		parsed = JSON.parse(raw) as LegacyRegistry;
	} catch (e) {
		return { error: `the registry file is not valid JSON: ${String(e)}` };
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
		return { error: "the registry file has no list of jobs" };
	}
	const jobs = parsed.jobs.filter((job): job is Job => {
		if (!job || typeof job !== "object") return false;
		const value = job as Partial<Job>;
		return typeof value.id === "string" && typeof value.status === "string";
	});
	return { jobs };
}

/**
 * Migrate the old registry into the database.
 *
 * A second call does nothing. The old file stays on disk.
 */
export function migrateRegistry(db: LifecycleDb, stateDir: string, existing: number): MigrationResult {
	if (db.meta("schema_version") === String(SCHEMA_VERSION)) {
		return { migrated: false, runs: existing, failure: { kind: "alreadyDone" } };
	}
	const source = legacyRegistryFile(stateDir);
	const read = readLegacyRegistry(source);
	if ("error" in read) {
		return { migrated: false, runs: existing, failure: { kind: "malformed", detail: read.error } };
	}
	db.write(() => {
		for (const job of read.jobs) {
			db.handle
				.prepare(
					`INSERT INTO runs (id, label, task, cwd, status, session_dir, session_file, pane_id, created_at, started_at, finished_at, result, error, payload)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO NOTHING`,
				)
				.run(
					job.id,
					job.label ?? job.id,
					job.task ?? "",
					job.cwd ?? "",
					job.status,
					job.sessionDir ?? "",
					job.sessionFile ?? null,
					job.paneId ?? null,
					job.createdAt ?? Date.now(),
					job.startedAt ?? null,
					job.finishedAt ?? null,
					job.result ?? null,
					job.error ?? null,
					JSON.stringify(job),
				);
		}
		db.setMeta("schema_version", String(SCHEMA_VERSION));
		db.setMeta("migrated_from", source);
	});
	return { migrated: true, runs: read.jobs.length, failure: null };
}

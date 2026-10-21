/**
 * The lifecycle database.
 *
 * One SQLite file in the state directory holds every lifecycle record. The
 * extension runs inside the OMP host, which uses the Bun runtime. Bun
 * implements the module `node:sqlite` in full, so the same import works in
 * the host and in the repository test run.
 *
 * Every write goes through a transaction. A transaction stays short. It never
 * spans a process command or a message injection.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The database file inside the state directory. */
export function databaseFile(stateDir: string): string {
	return join(stateDir, "lifecycle.db");
}

/** The schema version of the database. A migration raises it. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  task TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  session_dir TEXT NOT NULL,
  session_file TEXT,
  pane_id INTEGER,
  resource_group TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT,
  error TEXT,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS ownership (
  task_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  process_id INTEGER,
  process_started_at TEXT,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS launch_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  state TEXT NOT NULL,
  session_file TEXT,
  session_id TEXT,
  pane_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_groups (
  id TEXT PRIMARY KEY,
  session_dir TEXT NOT NULL,
  worktree_path TEXT,
  worktree_origin TEXT,
  worktree_branch TEXT,
  execution_holder TEXT,
  execution_state TEXT NOT NULL,
  disposing INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  call_id TEXT,
  job_id TEXT,
  start_evidence TEXT NOT NULL,
  observation TEXT NOT NULL,
  settlement_evidence TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  condition TEXT NOT NULL,
  payload TEXT,
  actionable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_handling (
  event_id TEXT PRIMARY KEY,
  disposition TEXT NOT NULL,
  note TEXT,
  owner_id TEXT,
  owner_generation INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_resolutions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  run_id TEXT,
  resolution TEXT NOT NULL,
  evidence_note TEXT NOT NULL,
  owner_id TEXT,
  owner_generation INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stop_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_run ON executions (run_id);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id);
CREATE INDEX IF NOT EXISTS attempts_job ON launch_attempts (job_id);
`;

/**
 * The lifecycle database.
 *
 * The handle is closed by `close`. The caller owns it. A module must not keep
 * a handle of its own.
 */
export interface LifecycleDb {
	readonly handle: DatabaseSync;
	/** Run a function in a write transaction. */
	write<T>(fn: () => T): T;
	/** Read a value of the meta table, or null. */
	meta(key: string): string | null;
	/** Write a value of the meta table. */
	setMeta(key: string, value: string): void;
	close(): void;
}

/**
 * Open the database and make sure the schema exists.
 *
 * The schema creation runs in one transaction. A second process that opens
 * the same file finds the tables and does nothing.
 */
export function openDatabase(file: string): LifecycleDb {
	mkdirSync(dirname(file), { recursive: true });
	const handle = new DatabaseSync(file);
	handle.exec("PRAGMA journal_mode = WAL;");
	handle.exec("PRAGMA foreign_keys = ON;");
	handle.exec("BEGIN IMMEDIATE;");
	try {
		handle.exec(SCHEMA);
		handle.exec("COMMIT;");
	} catch (e) {
		handle.exec("ROLLBACK;");
		handle.close();
		throw e;
	}

	let depth = 0;
	const db: LifecycleDb = {
		handle,
		write(fn) {
			// A nested write joins the outer transaction. The inner function
			// must not open a second transaction of its own.
			if (depth > 0) {
				depth += 1;
				try {
					return fn();
				} finally {
					depth -= 1;
				}
			}
			handle.exec("BEGIN IMMEDIATE;");
			depth = 1;
			try {
				const result = fn();
				handle.exec("COMMIT;");
				return result;
			} catch (e) {
				try {
					handle.exec("ROLLBACK;");
				} catch {
					/* a failed rollback must not hide the original error */
				}
				throw e;
			} finally {
				depth = 0;
			}
		},
		meta(key) {
			const row = handle.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
				| { value: string }
				| undefined;
			return row?.value ?? null;
		},
		setMeta(key, value) {
			handle
				.prepare(
					"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(key, value);
		},
		close() {
			handle.close();
		},
	};
	return db;
}

/**
 * The schema version that the database holds, or 0 for a fresh file.
 *
 * A file without the meta table has the version 0.
 */
export function schemaVersion(db: LifecycleDb): number {
	const raw = db.meta("schema_version");
	if (raw === null) return 0;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : 0;
}

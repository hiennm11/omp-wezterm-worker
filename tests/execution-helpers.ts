/**
 * The helpers of the execution tests.
 *
 * The tests need a fresh database and a transcript file. Both helpers live
 * here, so the test files do not copy them.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";

/** A database in a fresh directory. */
export function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-exec-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** Write a transcript that holds the given lines. */
export function writeTranscript(dir: string, name: string, lines: unknown[]): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
	return file;
}

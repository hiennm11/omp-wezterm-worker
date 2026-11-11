/**
 * The artifacts of the worker eval.
 *
 * The module writes the record of one experiment and the manifest of one run.
 * It reads them back for the resume. It also reads the version of the
 * package and the state of the git work tree.
 *
 * The module never chooses a root directory. The caller gives every path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExperimentRecord, PlanCell, RunManifest } from "./types.ts";

/** The suffix of every record file. */
const JSON_SUFFIX = ".json";

/** The name of the file that holds the manifest of a run. */
const MANIFEST_FILE = "manifest.json";

/** The marker of a temporary file of a write. */
const TEMP_MARKER = ".tmp-";

/** The version of the package when the file cannot be read. */
const UNKNOWN_VERSION = "unknown";

/** The version of the schema of a record. */
const RECORD_SCHEMA_VERSION = 1;

/** The decision of the resume for one experiment. */
export type ResumeDecision = "skip" | "run";

/**
 * The path of the record of one experiment.
 *
 * The caller gives the directory of the records and the id of the experiment.
 */
export function recordPath(experimentsDir: string, experimentId: string): string {
	return join(experimentsDir, `${experimentId}${JSON_SUFFIX}`);
}

/**
 * Write one value as JSON in an atomic way.
 *
 * The function writes the file under a temporary name in the same directory.
 * It then removes the target file and renames the temporary file. A reader
 * never sees a partial target file, because the rename is the last step.
 */
function writeJsonAtomic(dir: string, fileName: string, value: unknown): void {
	mkdirSync(dir, { recursive: true });
	const target = join(dir, fileName);
	const temp = join(dir, `${fileName}${TEMP_MARKER}${process.pid}`);
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		if (existsSync(target)) rmSync(target, { force: true });
		renameSync(temp, target);
	} finally {
		if (existsSync(temp)) rmSync(temp, { force: true });
	}
}

/**
 * Write the record of one experiment.
 *
 * The function creates the directory of the records when it does not exist.
 */
export function writeRecord(experimentsDir: string, record: ExperimentRecord): void {
	writeJsonAtomic(experimentsDir, `${record.experimentId}${JSON_SUFFIX}`, record);
}

/**
 * Check that a value is a record of one experiment.
 *
 * A record holds the schema version 1 and an identifier that is a string.
 * Every other value gives null.
 */
function asRecord(value: unknown): ExperimentRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const candidate = value as Partial<ExperimentRecord>;
	if (candidate.schemaVersion !== RECORD_SCHEMA_VERSION) return null;
	if (typeof candidate.experimentId !== "string") return null;
	return candidate as ExperimentRecord;
}

/**
 * Read the record of one experiment.
 *
 * The function returns null when the file is absent or holds an invalid
 * record.
 */
export function readRecord(experimentsDir: string, experimentId: string): ExperimentRecord | null {
	const path = recordPath(experimentsDir, experimentId);
	if (!existsSync(path)) return null;
	try {
		return asRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

/**
 * Read every valid record of a directory.
 *
 * The function skips a file that does not end in `.json`, a temporary file
 * and an invalid record. The result is sorted by the id of the experiment.
 */
export function listRecords(experimentsDir: string): ExperimentRecord[] {
	if (!existsSync(experimentsDir)) return [];
	const records: ExperimentRecord[] = [];
	for (const name of readdirSync(experimentsDir)) {
		if (!name.endsWith(JSON_SUFFIX)) continue;
		if (name.includes(TEMP_MARKER)) continue;
		const record = readRecord(experimentsDir, name.slice(0, -JSON_SUFFIX.length));
		if (record) records.push(record);
	}
	records.sort((a, b) => a.experimentId.localeCompare(b.experimentId));
	return records;
}

/**
 * Write the manifest of one run.
 *
 * The file sits in the directory of the run.
 */
export function writeManifest(runDir: string, manifest: RunManifest): void {
	writeJsonAtomic(runDir, MANIFEST_FILE, manifest);
}

/**
 * Read the manifest of one run.
 *
 * The function returns null when the file is absent or holds invalid JSON.
 */
export function readManifest(runDir: string): RunManifest | null {
	const path = join(runDir, MANIFEST_FILE);
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as RunManifest;
		if (typeof value !== "object" || value === null) return null;
		return value;
	} catch {
		return null;
	}
}

/**
 * The decision of the resume for one experiment.
 *
 * The function skips an experiment that already has a record with the same
 * fixture checksum and a finish time. Every other case runs the experiment
 * again.
 */
export function resumeDecision(planned: PlanCell, existing: ExperimentRecord | null): ResumeDecision {
	if (!existing) return "run";
	if (existing.fixtureChecksum !== planned.fixtureChecksum) return "run";
	if (existing.timing.finishedAt === null) return "run";
	return "skip";
}

/**
 * The short hash of the current commit.
 *
 * The function returns null when the call of git fails.
 */
export function readCommit(cwd: string): string | null {
	const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd,
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return null;
	const hash = result.stdout.trim();
	return hash.length > 0 ? hash : null;
}

/**
 * The state of the work tree.
 *
 * The function returns true when `git status --porcelain` holds a line.
 */
export function readDirty(cwd: string): boolean {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd,
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return false;
	return result.stdout.split("\n").some((line) => line.trim().length > 0);
}

/**
 * The version of the package of a root directory.
 *
 * The function returns `unknown` when the file is absent or holds invalid
 * JSON.
 */
export function packageVersion(root: string): string {
	const path = join(root, "package.json");
	if (!existsSync(path)) return UNKNOWN_VERSION;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
		if (typeof value.version !== "string") return UNKNOWN_VERSION;
		return value.version;
	} catch {
		return UNKNOWN_VERSION;
	}
}

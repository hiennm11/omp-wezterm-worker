/**
 * The dataset of the worker eval.
 *
 * The dataset holds one directory per task. The loader reads every task and
 * collects every problem. A problem names the task directory and the field.
 * The loader never guesses a value for a field that is not valid.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
	type Dataset,
	type DatasetIssue,
	type DatasetLoad,
	type DatasetManifest,
	type DatasetTask,
	DEFAULT_VERIFY_TIMEOUT_MS,
	DEFAULT_WORKER_TIMEOUT_MS,
	EXPECT_BEFORE_VALUES,
	type ExpectBefore,
	TASK_TYPES,
	type TaskType,
	type TaskVerify,
} from "./types.ts";

/** The name of the file that holds the manifest of the dataset. */
const MANIFEST_FILE = "dataset.json";

/** The name of the file that holds the text of a task. */
const TASK_FILE = "task.json";

/** The name of the file that holds the prompt of a task. */
const PROMPT_FILE = "task.md";

/** The name of the directory that holds the fixture of a task. */
const FIXTURE_DIR = "fixture";

/** The directory that a fixture must not hold. */
const GIT_DIR = ".git";

/** The prefix of every hash of the dataset. */
const HASH_PREFIX = "sha256:";

/** The separator of the parts of the fixture checksum. */
const PART_SEPARATOR = "\u0000";

/** Check that a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Add one problem to the list of problems. */
function addIssue(issues: DatasetIssue[], path: string, field: string, message: string): void {
	issues.push({ path, field, message });
}

/** The path of a file, relative to the root, with `/` separators. */
function relativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

/** The SHA-256 of the bytes, in hexadecimal. */
export function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under a directory, as an absolute path. */
function listFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listFiles(path));
		else if (entry.isFile()) found.push(path);
	}
	return found;
}

/**
 * The checksum of a fixture.
 *
 * The checksum covers the relative path and the bytes of every file. The
 * list of files is sorted by the relative path, so the order of the file
 * system does not change the result.
 */
export function fixtureChecksum(fixtureDir: string): string {
	const files = listFiles(fixtureDir)
		.map((path) => ({
			path: relativePath(fixtureDir, path),
			bytes: readFileSync(path),
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const text = files.map((file) => `${file.path}${PART_SEPARATOR}${sha256Hex(file.bytes)}\n`).join("");
	return `${HASH_PREFIX}${sha256Hex(Buffer.from(text, "utf8"))}`;
}

/** The hash of the prompt of a task. */
export function promptHash(promptPath: string): string {
	return `${HASH_PREFIX}${sha256Hex(readFileSync(promptPath))}`;
}

/** Copy a fixture into another directory. */
export function copyFixture(source: string, target: string): void {
	cpSync(source, target, { recursive: true });
}

/** Read the manifest of the dataset. */
function readManifest(root: string, issues: DatasetIssue[]): DatasetManifest | null {
	const path = join(root, MANIFEST_FILE);
	if (!existsSync(path)) {
		addIssue(issues, root, MANIFEST_FILE, `The dataset must hold a ${MANIFEST_FILE} file.`);
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		addIssue(issues, root, MANIFEST_FILE, `The field ${MANIFEST_FILE} must hold valid JSON.`);
		return null;
	}
	if (!isRecord(value)) {
		addIssue(issues, root, MANIFEST_FILE, `The field ${MANIFEST_FILE} must hold an object.`);
		return null;
	}
	const schemaVersion = value.schemaVersion;
	const version = value.version;
	if (typeof schemaVersion !== "number") {
		addIssue(issues, root, "schemaVersion", "The field schemaVersion must hold a number.");
		return null;
	}
	if (typeof version !== "string" || version.length === 0) {
		addIssue(issues, root, "version", "The field version must hold a non-empty string.");
		return null;
	}
	return { schemaVersion, version };
}

/** Read the check of a task. */
function readVerify(value: unknown, taskPath: string, issues: DatasetIssue[]): TaskVerify | null {
	if (!isRecord(value)) {
		addIssue(issues, taskPath, "verify", "The field verify must hold an object.");
		return null;
	}
	let valid = true;
	const command = value.command;
	if (!Array.isArray(command) || command.length === 0) {
		addIssue(issues, taskPath, "verify.command", "The field verify.command must hold a list.");
		valid = false;
	} else if (!command.every((part) => typeof part === "string" && part.length > 0)) {
		addIssue(issues, taskPath, "verify.command", "The field verify.command must hold only strings.");
		valid = false;
	}
	const timeoutMs = value.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		addIssue(issues, taskPath, "verify.timeoutMs", "The field verify.timeoutMs must hold a number.");
		valid = false;
	}
	const expectBefore = value.expectBefore;
	if (!EXPECT_BEFORE_VALUES.includes(expectBefore as ExpectBefore)) {
		addIssue(
			issues,
			taskPath,
			"verify.expectBefore",
			"The field verify.expectBefore must hold fail or pass.",
		);
		valid = false;
	}
	const protectedPaths = value.protectedPaths ?? [];
	if (!Array.isArray(protectedPaths) || !protectedPaths.every((path) => typeof path === "string")) {
		addIssue(
			issues,
			taskPath,
			"verify.protectedPaths",
			"The field verify.protectedPaths must hold a list of strings.",
		);
		valid = false;
	}
	if (!valid) return null;
	return {
		command: command as string[],
		timeoutMs: timeoutMs as number,
		expectBefore: expectBefore as ExpectBefore,
		protectedPaths: protectedPaths as string[],
	};
}

/** Read one task of the dataset. */
function readTask(
	root: string,
	taskDir: string,
	taskType: TaskType,
	issues: DatasetIssue[],
): DatasetTask | null {
	const taskPath = relativePath(root, taskDir);
	const file = join(taskDir, TASK_FILE);
	if (!existsSync(file)) {
		addIssue(issues, taskPath, TASK_FILE, `The task must hold a ${TASK_FILE} file.`);
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		addIssue(issues, taskPath, TASK_FILE, `The field ${TASK_FILE} must hold valid JSON.`);
		return null;
	}
	if (!isRecord(value)) {
		addIssue(issues, taskPath, TASK_FILE, `The field ${TASK_FILE} must hold an object.`);
		return null;
	}
	let valid = true;
	if (value.taskType !== taskType) {
		addIssue(issues, taskPath, "taskType", `The field taskType must hold ${taskType}.`);
		valid = false;
	}
	const workerTimeoutMs = value.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
	if (typeof workerTimeoutMs !== "number" || !Number.isFinite(workerTimeoutMs) || workerTimeoutMs <= 0) {
		addIssue(issues, taskPath, "workerTimeoutMs", "The field workerTimeoutMs must hold a number.");
		valid = false;
	}
	const verify = readVerify(value.verify, taskPath, issues);
	if (verify === null) valid = false;
	const prompt = join(taskDir, PROMPT_FILE);
	if (!existsSync(prompt)) {
		addIssue(issues, taskPath, PROMPT_FILE, `The task must hold a ${PROMPT_FILE} file.`);
		valid = false;
	}
	const fixtureDir = join(taskDir, FIXTURE_DIR);
	if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
		addIssue(issues, taskPath, FIXTURE_DIR, `The task must hold a ${FIXTURE_DIR} directory.`);
		valid = false;
	} else if (existsSync(join(fixtureDir, GIT_DIR))) {
		addIssue(
			issues,
			taskPath,
			`${FIXTURE_DIR}/${GIT_DIR}`,
			`The ${FIXTURE_DIR} directory must not hold a ${GIT_DIR} directory.`,
		);
		valid = false;
	}
	if (!valid || verify === null) return null;
	return {
		taskId: taskDir.split(sep).pop() ?? taskPath,
		taskType,
		taskDir,
		fixtureDir,
		workerTimeoutMs: workerTimeoutMs as number,
		verify,
		fixtureChecksum: fixtureChecksum(fixtureDir),
		promptHash: promptHash(prompt),
	};
}

/**
 * Read the dataset of a directory.
 *
 * The loader reads every task. It collects every problem it finds, so the
 * caller sees all of them at once.
 */
export function loadDataset(root: string): DatasetLoad {
	const issues: DatasetIssue[] = [];
	const manifest = readManifest(root, issues);
	const tasks: DatasetTask[] = [];
	for (const taskType of TASK_TYPES) {
		const typeDir = join(root, taskType);
		if (!existsSync(typeDir)) continue;
		for (const entry of readdirSync(typeDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const task = readTask(root, join(typeDir, entry.name), taskType, issues);
			if (task !== null) tasks.push(task);
		}
	}
	if (manifest === null || issues.length > 0) return { ok: false, issues };
	return { ok: true, dataset: { root, manifest, tasks } satisfies Dataset };
}

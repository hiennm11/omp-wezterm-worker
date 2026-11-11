/**
 * The types of the worker eval.
 *
 * The types describe the dataset, the plan and the result of the verifier.
 * They hold no logic, so a test can build a value of any type.
 */

/** The kinds of task that the benchmark runs. */
export const TASK_TYPES = ["bugfix", "implementation", "refactoring", "testing"] as const;

/** The kind of one task. */
export type TaskType = (typeof TASK_TYPES)[number];

/** The expected acceptance verdict on an untouched fixture. */
export type ExpectBefore = "fail" | "pass";

/** The values that `expectBefore` accepts. */
export const EXPECT_BEFORE_VALUES: ExpectBefore[] = ["fail", "pass"];

/** The default deadline of a worker, in milliseconds. */
export const DEFAULT_WORKER_TIMEOUT_MS = 900000;

/** The default deadline of the verifier, in milliseconds. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 60000;

/** The check that the verifier runs on a fixture. */
export interface TaskVerify {
	command: string[];
	timeoutMs: number;
	expectBefore: ExpectBefore;
	protectedPaths: string[];
}

/** The fields of a task that the planner needs. */
export interface PlanTask {
	taskId: string;
	taskType: TaskType;
	fixtureChecksum: string;
	promptHash: string;
}

/** One task of the dataset. */
export interface DatasetTask extends PlanTask {
	taskDir: string;
	fixtureDir: string;
	workerTimeoutMs: number;
	verify: TaskVerify;
}

/** The manifest of the dataset. */
export interface DatasetManifest {
	schemaVersion: number;
	version: string;
}

/** The dataset of the benchmark. */
export interface Dataset {
	root: string;
	manifest: DatasetManifest;
	tasks: DatasetTask[];
}

/** One problem of the dataset. */
export interface DatasetIssue {
	path: string;
	field: string;
	message: string;
}

/** The result of the loader of the dataset. */
export type DatasetLoad = { ok: true; dataset: Dataset } | { ok: false; issues: DatasetIssue[] };

/** One planned experiment. */
export interface PlanCell {
	experimentId: string;
	taskId: string;
	taskType: TaskType;
	model: string;
	effort: string;
	fixtureChecksum: string;
	promptHash: string;
}

/** The result of one verifier run. */
export interface VerifierResult {
	started: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	outputTail: string;
}

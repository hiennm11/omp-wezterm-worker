/**
 * The types of the worker eval.
 *
 * The types describe the dataset, the plan and the result of the verifier.
 * They hold no logic, so a test can build a value of any type.
 */

import type { UsageReport } from "../../extensions/lib/usage.ts";

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

/** The plan of a run, as the file `plan.json` holds it. */
export interface PlanFile {
	schemaVersion: 1;
	datasetVersion: string;
	pilot: boolean;
	models: string[];
	efforts: string[];
	runs: number;
	experiments: number;
	cells: PlanCell[];
}

/** The result of one verifier run. */
export interface VerifierResult {
	started: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	outputTail: string;
}

/** How the execution of one experiment ended. */
export type ExecutionOutcome = "completed" | "failed" | "cancelled" | "not_started" | "unknown";

/** The record of one experiment. */
export interface ExperimentRecord {
	schemaVersion: 1;
	experimentId: string;
	runId: string;
	taskId: string;
	taskType: TaskType;
	fixtureChecksum: string;
	promptHash: string;
	datasetVersion: string;
	configuration: {
		model: string;
		effort: string;
		packageVersion: string;
		commit: string;
		dirty: boolean;
	};
	timing: { startedAt: number | null; finishedAt: number | null };
	execution: {
		started: boolean;
		outcome: ExecutionOutcome;
		jobId: string | null;
		status: string | null;
		error: string | null;
		stop: string | null;
		turns: number | null;
		wallMs: number | null;
		transcript: string | null;
	};
	verification: {
		verdict: "PASS" | "FAIL" | "BLOCKED";
		reason: string;
		command: string[];
		exitCode: number | null;
		started: boolean;
		timedOut: boolean;
		durationMs: number;
		restoredPaths: string[];
		outputTail: string;
	};
	usage: UsageReport | null;
	resultText: string | null;
}

/** One cell of the report, the group of the runs of one configuration. */
export interface ReportCell {
	taskType: TaskType;
	model: string;
	effort: string;
	runs: number;
	pass: number;
	fail: number;
	blocked: number;
	valid: number;
	successRate: number;
	usageMeasured: number;
	usagePartial: number;
	usageUnknown: number;
	medianWallMs: number | null;
	medianTurns: number | null;
	costKnownSum: number;
	costComplete: boolean;
}

/** The report of one benchmark run, as the file `report.json` holds it. */
export interface ReportFile {
	schemaVersion: 1;
	runId: string;
	datasetVersion: string;
	commit: string;
	cells: ReportCell[];
}

/** The manifest of one benchmark run. */
export interface RunManifest {
	schemaVersion: 1;
	runId: string;
	createdAt: number;
	datasetVersion: string;
	packageVersion: string;
	commit: string;
	dirty: boolean;
	environment: Record<string, string>;
	models: string[];
	efforts: string[];
	pilot: boolean;
	taskCount: number;
}

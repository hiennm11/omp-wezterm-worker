/**
 * The runner of the worker eval.
 *
 * The runner runs one experiment through the test host. It starts one
 * worker, waits for the end, restores the protected paths, runs the
 * verifier and writes one record. It never retries a worker and never
 * resumes a worker.
 *
 * The host is an interface. The test host of `tests/harness.ts` satisfies
 * the interface, and a fake host satisfies it too. The module names no
 * test host, so a test can run the runner without a pane.
 */

import { readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { UsageReport } from "../../extensions/lib/usage.ts";
import { acceptanceVerdict, restoreProtectedPaths } from "./acceptance.ts";
import { listRecords, resumeDecision, writeRecord } from "./artifact.ts";
import { copyFixture } from "./dataset.ts";
import { detailString, outcomeOf, type RunnerHost, waitForEnd } from "./runner-host.ts";
import type { DatasetTask, ExecutionOutcome, ExperimentRecord, PlanCell, PlanFile } from "./types.ts";
import { runVerifier } from "./verifier.ts";

export type { RunnerHost } from "./runner-host.ts";

/** The time that the runner waits after the deadline of the worker. */
const DEADLINE_GRACE_MS = 60_000;

/** The token in a command that names the directory of the task. */
const DATASET_TOKEN = "{dataset}";

/** The name of the file that holds the prompt of a task. */
const PROMPT_FILE = "task.md";

/** The directories of one run. */
export interface RunPaths {
	runDir: string;
	experimentsDir: string;
	fixturesDir: string;
	stateDir: string;
}

/** The environment of one run. */
export interface RunEnvironment {
	datasetVersion: string;
	packageVersion: string;
	commit: string;
	dirty: boolean;
	environment: Record<string, string>;
}

/** The command of a task, with the token of the dataset replaced. */
export function resolveCommand(task: DatasetTask): string[] {
	return task.verify.command.map((part) => part.split(DATASET_TOKEN).join(resolve(task.taskDir)));
}

/**
 * Build the record of a run that never reached the verifier.
 *
 * The record names the reason in the verification and in the execution.
 */
function blockedRecord(
	cell: PlanCell,
	paths: RunPaths,
	env: RunEnvironment,
	reason: string,
): ExperimentRecord {
	const now = Date.now();
	return {
		schemaVersion: 1,
		experimentId: cell.experimentId,
		runId: basename(paths.runDir),
		taskId: cell.taskId,
		taskType: cell.taskType,
		fixtureChecksum: cell.fixtureChecksum,
		promptHash: cell.promptHash,
		datasetVersion: env.datasetVersion,
		configuration: {
			model: cell.model,
			effort: cell.effort,
			packageVersion: env.packageVersion,
			commit: env.commit,
			dirty: env.dirty,
		},
		timing: { startedAt: now, finishedAt: now },
		execution: {
			started: false,
			outcome: "unknown",
			jobId: null,
			status: null,
			error: reason,
			stop: null,
			turns: null,
			wallMs: null,
			transcript: null,
		},
		verification: {
			verdict: "BLOCKED",
			reason,
			command: [],
			exitCode: null,
			started: false,
			timedOut: false,
			durationMs: 0,
			restoredPaths: [],
			outputTail: "",
		},
		usage: null,
		resultText: null,
	};
}

/**
 * Run one experiment through the test host.
 *
 * The function starts one worker, waits for the end, restores the
 * protected paths, runs the verifier and writes one record. A failure
 * before the verifier gives a `BLOCKED` record, and the record is still
 * written.
 */
export async function runExperiment(
	host: RunnerHost,
	task: DatasetTask,
	cell: PlanCell,
	paths: RunPaths,
	env: RunEnvironment,
): Promise<ExperimentRecord> {
	const runFixtureDir = join(paths.fixturesDir, cell.experimentId);
	let command: string[] = [];
	let fixtureCopied = false;
	let workerId: string | null = null;
	let started = false;
	let outcome: ExecutionOutcome = "not_started";
	let status: string | null = null;
	let error: string | null = null;
	let stop: string | null = null;
	let turns: number | null = null;
	let wallMs: number | null = null;
	let transcript: string | null = null;
	let usage: UsageReport | null = null;
	let resultText: string | null = null;
	let restoredPaths: string[] = [];
	let startedAt = Date.now();
	let failure: string | null = null;

	try {
		command = resolveCommand(task);
		const text = readFileSync(join(task.taskDir, PROMPT_FILE), "utf8");
		try {
			rmSync(runFixtureDir, { recursive: true, force: true });
			copyFixture(task.fixtureDir, runFixtureDir);
			fixtureCopied = true;
		} catch {
			fixtureCopied = false;
		}
		/* The event resets the launch limit of the request. */
		await host.fire("input", {});
		startedAt = Date.now();
		const spawn = await host.call("wezterm_spawn_worker", {
			task: text,
			cwd: runFixtureDir,
			label: `eval ${cell.experimentId}`,
			model: cell.model,
			thinking: cell.effort,
			timeoutMs: task.workerTimeoutMs,
			isolated: false,
			closePaneOnFinish: true,
		});
		workerId = detailString(spawn.details, "workerId");
		started = workerId !== null;
		if (spawn.isError === true) {
			error = host.text(spawn);
		} else if (workerId === null) {
			error = "the spawn returned no worker id";
		}
		if (workerId !== null) {
			const ended = await waitForEnd(host, workerId, task.workerTimeoutMs + DEADLINE_GRACE_MS);
			if (ended.timedOut) {
				try {
					await host.call("wezterm_worker_cancel", { workerId });
				} catch {
					/* the worker may already be gone */
				}
				outcome = "failed";
				error = "the runner reached its deadline";
			} else if (ended.row !== null) {
				outcome = outcomeOf(ended.row.status);
				status = ended.row.status;
				error = ended.row.error;
				stop = ended.row.stop;
				turns = ended.row.turns;
				wallMs = ended.row.elapsedMs;
				transcript = ended.row.transcript;
				usage = ended.row.usage;
			}
			const result = await host.call("wezterm_worker_result", { workerId });
			resultText = detailString(result.details, "result");
		}
	} catch (caught) {
		failure = caught instanceof Error ? caught.message : String(caught);
		outcome = "unknown";
	}

	let verdict: "PASS" | "FAIL" | "BLOCKED";
	let reason: string;
	let exitCode: number | null = null;
	let verifierStarted = false;
	let timedOut = false;
	let durationMs = 0;
	let outputTail = "";
	if (failure !== null) {
		verdict = "BLOCKED";
		reason = `the runner failed: ${failure}`;
	} else {
		/* A worker can delete a test file or weaken an assertion. The
		   restore brings the protected paths back before the verifier. */
		if (started && fixtureCopied) {
			const restore = restoreProtectedPaths(task.fixtureDir, runFixtureDir, task.verify.protectedPaths);
			restoredPaths = restore.restored;
		}
		const verifier =
			started && fixtureCopied
				? runVerifier(command, runFixtureDir, task.verify.timeoutMs)
				: { started: false, exitCode: null, timedOut: false, durationMs: 0, outputTail: "" };
		const evidence = acceptanceVerdict({ workerStarted: started, fixtureCopied, verifier });
		verdict = evidence.verdict;
		reason = evidence.reason;
		exitCode = verifier.exitCode;
		verifierStarted = verifier.started;
		timedOut = verifier.timedOut;
		durationMs = verifier.durationMs;
		outputTail = verifier.outputTail;
	}

	const record: ExperimentRecord = {
		schemaVersion: 1,
		experimentId: cell.experimentId,
		runId: basename(paths.runDir),
		taskId: cell.taskId,
		taskType: cell.taskType,
		fixtureChecksum: cell.fixtureChecksum,
		promptHash: cell.promptHash,
		datasetVersion: env.datasetVersion,
		configuration: {
			model: cell.model,
			effort: cell.effort,
			packageVersion: env.packageVersion,
			commit: env.commit,
			dirty: env.dirty,
		},
		timing: { startedAt, finishedAt: Date.now() },
		execution: { started, outcome, jobId: workerId, status, error, stop, turns, wallMs, transcript },
		verification: {
			verdict,
			reason,
			command,
			exitCode,
			started: verifierStarted,
			timedOut,
			durationMs,
			restoredPaths,
			outputTail,
		},
		usage,
		resultText,
	};
	writeRecord(paths.experimentsDir, record);
	return record;
}

/**
 * Run the cells of a plan one by one.
 *
 * The function reads the records of the run first. A cell whose record is
 * finished and whose fixture checksum matches is skipped. Every other cell
 * runs. A failure of the machinery is data, so the function continues with
 * the next cell.
 */
export async function runPlan(
	host: RunnerHost,
	plan: PlanFile,
	tasks: DatasetTask[],
	paths: RunPaths,
	env: RunEnvironment,
): Promise<ExperimentRecord[]> {
	const existing = listRecords(paths.experimentsDir);
	const byExperiment = new Map(existing.map((record) => [record.experimentId, record]));
	const byTask = new Map(tasks.map((task) => [task.taskId, task]));
	const records: ExperimentRecord[] = [];
	for (const cell of plan.cells) {
		const known = byExperiment.get(cell.experimentId) ?? null;
		if (resumeDecision(cell, known) === "skip") continue;
		const task = byTask.get(cell.taskId);
		if (task === undefined) {
			const record = blockedRecord(cell, paths, env, `the dataset holds no task ${cell.taskId}`);
			writeRecord(paths.experimentsDir, record);
			records.push(record);
			continue;
		}
		try {
			records.push(await runExperiment(host, task, cell, paths, env));
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			const record = blockedRecord(cell, paths, env, `the runner failed: ${message}`);
			writeRecord(paths.experimentsDir, record);
			records.push(record);
		}
	}
	return records;
}

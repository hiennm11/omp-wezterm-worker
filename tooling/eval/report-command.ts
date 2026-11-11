/**
 * The commands `report` and `recommend` of the worker eval.
 *
 * The command `report` reads the records of a run, aggregates them into
 * cells and writes the report and the summary. The command `recommend`
 * reads the report of a run and names the configuration that the run
 * favors.
 *
 * The commands never start a worker and never change a record.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { listRecords, readManifest } from "./artifact.ts";
import { formatSummary, formatTable } from "./format.ts";
import { recommend } from "./recommend.ts";
import { buildReport } from "./report.ts";
import { type ReportFile, type RunManifest, TASK_TYPES, type TaskType } from "./types.ts";

/** The exit code of a usage error or a missing file. */
export const USAGE_EXIT = 2;

/** The name of the file that holds the report of a run. */
const REPORT_FILE = "report.json";

/** The name of the directory that holds the records of a run. */
const EXPERIMENTS_DIR = "experiments";

/** The default directory of the summary of a run. */
const DEFAULT_SUMMARY_DIR = "docs/trials";

/** The options of the command `report`. */
const REPORT_OPTIONS = {
	run: { type: "string" },
	"task-type": { type: "string" },
	"summary-dir": { type: "string" },
} as const;

/** The options of the command `recommend`. */
const RECOMMEND_OPTIONS = {
	run: { type: "string" },
	"task-type": { type: "string" },
} as const;

/**
 * Check that a value names a task type.
 *
 * The function returns null when the value names a task type, and the
 * message of the refusal otherwise.
 */
function checkTaskType(value: string): string | null {
	if ((TASK_TYPES as readonly string[]).includes(value)) return null;
	return `The task type ${value} is unknown. The task types are ${TASK_TYPES.join(", ")}.`;
}

/**
 * Read the report of a run.
 *
 * The function returns null when the file is absent or holds invalid JSON.
 */
export function readReport(runDir: string): ReportFile | null {
	const path = join(runDir, REPORT_FILE);
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as ReportFile;
		if (typeof value !== "object" || value === null || !Array.isArray(value.cells)) return null;
		return value;
	} catch {
		return null;
	}
}

/**
 * The name of the run of a directory.
 *
 * The function uses the identifier of the manifest when it holds one, and
 * the name of the directory otherwise.
 */
function runIdOf(runDir: string, manifest: RunManifest | null): string {
	return manifest?.runId ?? basename(runDir);
}

/**
 * The dataset version and the commit of a run.
 *
 * The function reads the manifest of the run. A run without a manifest
 * holds an empty version and an empty commit.
 */
function versionsOf(manifest: RunManifest | null): { datasetVersion: string; commit: string } {
	return {
		datasetVersion: manifest?.datasetVersion ?? "",
		commit: manifest?.commit ?? "",
	};
}

/**
 * The command `report`. Returns the exit code.
 *
 * The command reads the records of the run, writes `report.json` and the
 * summary, and prints the table of the cells.
 */
export function reportCommand(args: string[]): number {
	let values: { values: { run?: string; "task-type"?: string; "summary-dir"?: string } };
	try {
		values = parseArgs({ args, options: REPORT_OPTIONS });
	} catch (error) {
		console.error(`The command report does not accept the arguments: ${(error as Error).message}`);
		return USAGE_EXIT;
	}
	const runOption = values.values.run;
	if (runOption === undefined) {
		console.error("The command report needs --run.");
		return USAGE_EXIT;
	}
	const taskTypeOption = values.values["task-type"];
	if (taskTypeOption !== undefined) {
		const refusal = checkTaskType(taskTypeOption);
		if (refusal !== null) {
			console.error(refusal);
			return USAGE_EXIT;
		}
	}
	const runDir = resolve(runOption);
	const records = listRecords(join(runDir, EXPERIMENTS_DIR));
	if (records.length === 0) {
		console.error(`The run directory ${runDir} holds no record.`);
		return USAGE_EXIT;
	}
	const manifest = readManifest(runDir);
	const versions = versionsOf(manifest);
	const report = buildReport(records, runIdOf(runDir, manifest), versions.datasetVersion, versions.commit);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");

	const cells =
		taskTypeOption === undefined
			? report.cells
			: report.cells.filter((cell) => cell.taskType === taskTypeOption);
	console.log(formatTable(cells));

	const summaryDir = resolve(values.values["summary-dir"] ?? DEFAULT_SUMMARY_DIR);
	mkdirSync(summaryDir, { recursive: true });
	const summaryPath = join(summaryDir, `worker-eval-${report.runId}.md`);
	writeFileSync(summaryPath, formatSummary(report, manifest?.environment ?? {}), "utf8");
	console.log(`Report: ${join(runDir, REPORT_FILE)}`);
	console.log(`Summary: ${summaryPath}`);
	return 0;
}

/**
 * The command `recommend`. Returns the exit code.
 *
 * The command reads the report of the run, or builds it from the records
 * when the file is absent. It prints the recommended configuration, the
 * evidence and the fallback.
 */
export function recommendCommand(args: string[]): number {
	let values: { values: { run?: string; "task-type"?: string } };
	try {
		values = parseArgs({ args, options: RECOMMEND_OPTIONS });
	} catch (error) {
		console.error(`The command recommend does not accept the arguments: ${(error as Error).message}`);
		return USAGE_EXIT;
	}
	const runOption = values.values.run;
	if (runOption === undefined) {
		console.error("The command recommend needs --run.");
		return USAGE_EXIT;
	}
	const taskTypeOption = values.values["task-type"];
	if (taskTypeOption === undefined) {
		console.error("The command recommend needs --task-type.");
		return USAGE_EXIT;
	}
	const refusal = checkTaskType(taskTypeOption);
	if (refusal !== null) {
		console.error(refusal);
		return USAGE_EXIT;
	}
	const taskType = taskTypeOption as TaskType;
	const runDir = resolve(runOption);
	const manifest = readManifest(runDir);
	const versions = versionsOf(manifest);
	const runId = runIdOf(runDir, manifest);
	let report = readReport(runDir);
	if (report === null) {
		const records = listRecords(join(runDir, EXPERIMENTS_DIR));
		if (records.length === 0) {
			console.error(`The run directory ${runDir} holds no report and no record.`);
			return USAGE_EXIT;
		}
		report = buildReport(records, runId, versions.datasetVersion, versions.commit);
	}

	const result = recommend(report.cells, taskType);
	console.log(`Task type: ${taskType}`);
	if (result.recommended === null) {
		console.log(`Recommended: none. ${result.reason}.`);
	} else {
		console.log(`Recommended: ${result.recommended.model}, effort ${result.recommended.effort}`);
		console.log(`Evidence: ${result.reason}.`);
		if (result.fallback === null) {
			console.log("Fallback: none. The run holds no second eligible cell.");
		} else {
			console.log(`Fallback: ${result.fallback.model}, effort ${result.fallback.effort}`);
		}
	}
	console.log(`Run: ${report.runId}, dataset ${report.datasetVersion}, commit ${report.commit}`);
	return 0;
}

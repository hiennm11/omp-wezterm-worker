/**
 * The command line of the worker eval.
 *
 * The command `plan` reads a dataset and writes the matrix of the
 * experiments. A dry run validates every fixture of the dataset and writes
 * nothing.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { copyFixture, loadDataset } from "./dataset.ts";
import { buildPlan, dirtyRefusal } from "./planner.ts";
import { runExperiments } from "./run-command.ts";
import { resolveCommand } from "./runner.ts";
import type { DatasetTask, PlanCell } from "./types.ts";
import { runVerifier } from "./verifier.ts";

/** The exit code of a usage error, a dataset error or a refusal. */
const USAGE_EXIT = 2;

/** The exit code of an internal error. */
const INTERNAL_EXIT = 1;

/** The default directory of the plan. */
const DEFAULT_OUT = ".eval";

/** The options of the command `plan`. */
const PLAN_OPTIONS = {
	dataset: { type: "string" },
	models: { type: "string" },
	efforts: { type: "string" },
	out: { type: "string" },
	pilot: { type: "boolean", default: false },
	"dry-run": { type: "boolean", default: false },
	"allow-dirty": { type: "boolean", default: false },
} as const;

/** The options of the command `run`. */
const RUN_OPTIONS = {
	run: { type: "string" },
	concurrency: { type: "string", default: "1" },
} as const;

/** The names of the files that the status of the work tree holds. */
export function changedFiles(status: string): string[] {
	const files: string[] = [];
	for (const line of status.split("\n")) {
		if (line.trim().length === 0) continue;
		let path = line.slice(3).trim();
		const arrow = path.indexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4);
		files.push(path.replace(/^"|"$/g, ""));
	}
	return files;
}

/** The changed files of the work tree of a directory. */
function gitStatus(root: string): string[] {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error !== undefined) {
		throw new Error(`The command git status failed: ${result.error.message}`);
	}
	return changedFiles(result.stdout);
}

/** The observed verdict of a verifier run. */
type Observed = "pass" | "fail" | "error";

/**
 * Run the verifier on a copy of the fixture of a task.
 *
 * The copy goes into a temporary directory. The copy is removed before the
 * function returns.
 */
function observeFixture(task: DatasetTask): { observed: Observed; reason: string } {
	const temp = mkdtempSync(join(tmpdir(), "eval-dry-"));
	try {
		const copy = join(temp, "fixture");
		copyFixture(task.fixtureDir, copy);
		const result = runVerifier(resolveCommand(task), copy, task.verify.timeoutMs);
		if (!result.started) return { observed: "error", reason: "the verifier did not start" };
		if (result.timedOut) return { observed: "error", reason: "the verifier reached its timeout" };
		if (result.exitCode === 0) return { observed: "pass", reason: "" };
		return { observed: "fail", reason: "" };
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

/** The result of the validation of the fixtures of a dataset. */
interface Validation {
	lines: string[];
	failed: boolean;
}

/**
 * Validate every fixture of the dataset.
 *
 * Every task gives one line. A task whose fixture behaves as the dataset
 * says gives a PASS line. Every other task gives a FAIL line with a reason.
 */
export function validateFixtures(tasks: DatasetTask[]): Validation {
	const lines: string[] = [];
	let failed = false;
	for (const task of tasks) {
		const { observed, reason } = observeFixture(task);
		if (observed === "error") {
			lines.push(`FAIL ${task.taskId} ${reason}`);
			failed = true;
			continue;
		}
		if (observed === task.verify.expectBefore) {
			lines.push(`PASS ${task.taskId}`);
			continue;
		}
		failed = true;
		lines.push(
			`FAIL ${task.taskId} the fixture gave ${observed} and the dataset says ${task.verify.expectBefore}`,
		);
	}
	return { lines, failed };
}

/** The plan that the command writes. */
function buildPlanFile(
	datasetVersion: string,
	pilot: boolean,
	models: string[],
	efforts: string[],
	cells: PlanCell[],
): string {
	const plan = {
		schemaVersion: 1,
		datasetVersion,
		pilot,
		models,
		efforts,
		runs: cells.length,
		experiments: cells.length,
		cells,
	};
	return `${JSON.stringify(plan, null, 2)}\n`;
}

/** The command `plan`. Returns the exit code. */
function planCommand(args: string[]): number {
	let values: {
		values: {
			dataset?: string;
			models?: string;
			efforts?: string;
			out?: string;
			pilot: boolean;
			"dry-run": boolean;
			"allow-dirty": boolean;
		};
	};
	try {
		values = parseArgs({ args, options: PLAN_OPTIONS });
	} catch (error) {
		console.error(`The command plan does not accept the arguments: ${(error as Error).message}`);
		return USAGE_EXIT;
	}
	const datasetOption = values.values.dataset;
	const modelsOption = values.values.models;
	const effortsOption = values.values.efforts;
	if (datasetOption === undefined || modelsOption === undefined || effortsOption === undefined) {
		console.error("The command plan needs --dataset, --models and --efforts.");
		return USAGE_EXIT;
	}
	const models = modelsOption.split(",").filter((model) => model.length > 0);
	const efforts = effortsOption.split(",").filter((effort) => effort.length > 0);
	if (models.length === 0 || efforts.length === 0) {
		console.error("The command plan needs at least one model and at least one effort.");
		return USAGE_EXIT;
	}
	const pilot = values.values.pilot === true;
	const dryRun = values.values["dry-run"] === true;
	const allowDirty = values.values["allow-dirty"] === true;

	let changed: string[];
	try {
		changed = gitStatus(process.cwd());
	} catch (error) {
		console.error((error as Error).message);
		return INTERNAL_EXIT;
	}
	const refusal = dirtyRefusal(changed, allowDirty);
	if (refusal !== null) {
		console.error(refusal);
		return USAGE_EXIT;
	}

	const loaded = loadDataset(resolve(datasetOption));
	if (!loaded.ok) {
		for (const issue of loaded.issues) {
			console.error(`${issue.path}: ${issue.field}: ${issue.message}`);
		}
		console.error(`The dataset holds ${loaded.issues.length} problems.`);
		return USAGE_EXIT;
	}
	const dataset = loaded.dataset;
	const result = buildPlan(dataset.tasks, models, efforts, pilot);
	if (!result.ok) {
		console.error(result.message);
		return USAGE_EXIT;
	}
	if (dryRun) {
		const validation = validateFixtures(dataset.tasks);
		for (const line of validation.lines) console.log(line);
		if (validation.failed) {
			console.error("The dataset holds a fixture that does not match its expectation.");
			return USAGE_EXIT;
		}
	} else {
		const out = resolve(values.values.out ?? DEFAULT_OUT);
		mkdirSync(out, { recursive: true });
		const usedEfforts = pilot ? efforts.slice(0, 2) : efforts;
		writeFileSync(
			join(out, "plan.json"),
			buildPlanFile(dataset.manifest.version, pilot, models, usedEfforts, result.cells),
			"utf8",
		);
	}
	console.log(`Runs: ${result.cells.length}`);
	console.log(`Experiments: ${result.cells.length}`);
	return 0;
}

/** The command `run`. Returns the exit code. */
async function runCommand(args: string[]): Promise<number> {
	let values: { values: { run?: string; concurrency: string } };
	try {
		values = parseArgs({ args, options: RUN_OPTIONS });
	} catch (error) {
		console.error(`The command run does not accept the arguments: ${(error as Error).message}`);
		return USAGE_EXIT;
	}
	const runOption = values.values.run;
	if (runOption === undefined) {
		console.error("The command run needs --run.");
		return USAGE_EXIT;
	}
	const concurrency = Number.parseInt(values.values.concurrency, 10);
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		console.error("The command run needs a concurrency of 1 or more.");
		return USAGE_EXIT;
	}
	const runDir = resolve(runOption);
	return await runExperiments(runDir, concurrency);
}

/** The entry of the command. Returns the exit code. */
export async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	if (command === "plan") return planCommand(args);
	if (command === "run") return await runCommand(args);
	console.error(
		"The command needs a subcommand. The command plan builds the matrix. The command run runs the plan.",
	);
	return USAGE_EXIT;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		console.error((error as Error).message);
		process.exit(INTERNAL_EXIT);
	}
}

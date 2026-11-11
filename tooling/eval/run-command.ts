/**
 * The command `run` of the worker eval.
 *
 * The command reads the plan of a run and runs every cell of the plan one
 * by one. It creates the test host, so the workers run in real panes. The
 * command closes every worker and every pane when it ends.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

import { closePanesAndWait, createHost, sessionContext } from "../../tests/harness.ts";
import { readManifest } from "./artifact.ts";
import { loadDataset } from "./dataset.ts";
import { type RunEnvironment, type RunPaths, runPlan } from "./runner.ts";
import type { PlanFile } from "./types.ts";

/** The exit code of a usage error or a missing file. */
export const USAGE_EXIT = 2;

/** The number of experiments that the command runs at the same time. */
export const ONLY_ONE = 1;

/** The name of the file that holds the plan of a run. */
const PLAN_FILE = "plan.json";

/** The names of the programs whose version the environment holds. */
const VERSION_PROGRAMS = ["omp", "herdr", "wezterm"];

/** The version of a program, or null when the program cannot run. */
function programVersion(name: string): string | null {
	const probe = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true });
	if (probe.status !== 0) return null;
	const text = probe.stdout.trim();
	return text.length > 0 ? text : null;
}

/**
 * The environment of the machine.
 *
 * The environment holds the version of node, the platform, the
 * architecture and the version of every program that runs. A program that
 * cannot run is left out.
 */
export function machineEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {
		node: process.version,
		platform: platform(),
		arch: arch(),
	};
	for (const program of VERSION_PROGRAMS) {
		const version = programVersion(program);
		if (version !== null) environment[program] = version;
	}
	return environment;
}

/** The directories of one run. */
export function runPaths(runDir: string): RunPaths {
	return {
		runDir,
		experimentsDir: join(runDir, "experiments"),
		fixturesDir: join(runDir, "fixtures"),
		stateDir: join(runDir, "state"),
	};
}

/** Read the plan of a run. The function returns null when the file is absent or invalid. */
export function readPlan(runDir: string): PlanFile | null {
	const path = join(runDir, PLAN_FILE);
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as PlanFile;
		if (typeof value !== "object" || value === null || !Array.isArray(value.cells)) return null;
		return value;
	} catch {
		return null;
	}
}

/** The environment of one run, from the manifest of the run. */
export function runEnvironment(runDir: string): RunEnvironment | null {
	const manifest = readManifest(runDir);
	if (manifest === null) return null;
	return {
		datasetVersion: manifest.datasetVersion,
		packageVersion: manifest.packageVersion,
		commit: manifest.commit,
		dirty: manifest.dirty,
		environment: machineEnvironment(),
	};
}

/**
 * The dataset of a run.
 *
 * The run directory holds a copy of the dataset under the name `dataset`.
 * A run directory without that copy uses the dataset of the repository.
 */
export function datasetOf(runDir: string): string {
	const copy = join(runDir, "dataset");
	if (existsSync(copy)) return copy;
	return join(process.cwd(), "tooling/eval/datasets");
}

/**
 * Leave the session of a worker.
 *
 * The extension reads the session directory of the process to learn its
 * role. A process that holds the session of a worker registers only the
 * report tool, so the runner cannot start a worker. The benchmark is a
 * top level process, so the variables of a worker must not reach it.
 */
export function leaveWorkerSession(): void {
	delete process.env.OMP_WORKER_SESSION_DIR;
	delete process.env.PI_SESSION_FILE;
}

/**
 * Run the plan of a run directory.
 *
 * The function returns the exit code of the command. A record that holds a
 * `FAIL` or a `BLOCKED` verdict is data, so the exit code stays 0.
 */
export async function runExperiments(runDir: string, concurrency: number): Promise<number> {
	if (concurrency !== ONLY_ONE) {
		console.error("The command run needs a concurrency of 1. The limit of maxActiveWorkers is 3.");
		return USAGE_EXIT;
	}
	const plan = readPlan(runDir);
	if (plan === null) {
		console.error(`The run directory ${runDir} holds no plan file.`);
		return USAGE_EXIT;
	}
	const environment = runEnvironment(runDir);
	if (environment === null) {
		console.error(`The run directory ${runDir} holds no manifest file.`);
		return USAGE_EXIT;
	}
	const loaded = loadDataset(datasetOf(runDir));
	if (!loaded.ok) {
		for (const issue of loaded.issues) console.error(`${issue.path}: ${issue.field}: ${issue.message}`);
		return USAGE_EXIT;
	}
	const tasks = loaded.dataset.tasks;
	const paths = runPaths(runDir);
	mkdirSync(paths.stateDir, { recursive: true });
	mkdirSync(paths.fixturesDir, { recursive: true });
	leaveWorkerSession();
	const host = createHost({ stateDir: paths.stateDir, cwd: process.cwd() });
	await host.fire("session_start", sessionContext(process.cwd()));
	try {
		const records = await runPlan(host, plan, tasks, paths, environment);
		for (const record of records) {
			console.log(`${record.verification.verdict} ${record.experimentId} ${record.taskId}`);
		}
	} finally {
		for (const workerId of host.workers) {
			try {
				await host.call("wezterm_worker_cancel", { workerId });
			} catch {
				/* the worker may already be gone */
			}
		}
		await closePanesAndWait([...host.panes]);
	}
	return 0;
}

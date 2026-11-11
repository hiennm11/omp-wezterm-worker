/**
 * The planner of the worker eval.
 *
 * The planner builds the matrix of the experiments. Its functions are pure,
 * so a test calls them without a process and without a pane.
 */

import type { PlanCell, PlanTask, TaskType } from "./types.ts";

/** The number of efforts that the pilot uses. */
export const PILOT_EFFORT_COUNT = 2;

/** The prefix of the identifier of an experiment. */
const EXPERIMENT_PREFIX = "exp-";

/** The number of digits of the counter of an experiment. */
const EXPERIMENT_DIGITS = 4;

/** The prefix of an alias that a router can resolve. */
const ALIAS_PREFIX = "auto/";

/** The separator of a model and its effort suffix. */
const EFFORT_SUFFIX = ":";

/** The task types that the pilot covers. */
const PILOT_TYPES: TaskType[] = ["bugfix", "implementation", "refactoring"];

/** The result of the planner. */
export type PlanResult = { ok: true; cells: PlanCell[] } | { ok: false; message: string };

/** The result of the selection of the tasks of the pilot. */
export type PilotResult = { ok: true; tasks: PlanTask[] } | { ok: false; message: string };

/** The identifier of one experiment. */
export function experimentId(counter: number): string {
	return `${EXPERIMENT_PREFIX}${String(counter).padStart(EXPERIMENT_DIGITS, "0")}`;
}

/** The key of one cell of the matrix. */
function cellKey(taskId: string, model: string, effort: string): string {
	return `${taskId}\u0000${model}\u0000${effort}`;
}

/**
 * Check the model names of a plan.
 *
 * The planner refuses a model with an effort suffix, because the effort of
 * the plan sets the suffix. It refuses an alias, because a router can choose
 * a different model between two runs.
 */
export function checkModels(models: string[]): string | null {
	for (const model of models) {
		if (model.includes(EFFORT_SUFFIX)) {
			return `The model ${model} must not hold a colon. The effort of the plan sets the suffix.`;
		}
		if (model.startsWith(ALIAS_PREFIX)) {
			return `The model ${model} must not be an alias. A router can choose a different model between two runs.`;
		}
	}
	return null;
}

/**
 * Choose the tasks of the pilot.
 *
 * The pilot takes the first task of the bugfix type, of the implementation
 * type and of the refactoring type. It refuses the plan when a type is
 * missing.
 */
export function selectPilot(tasks: PlanTask[]): PilotResult {
	const chosen: PlanTask[] = [];
	for (const type of PILOT_TYPES) {
		const first = tasks.find((task) => task.taskType === type);
		if (first === undefined) {
			return { ok: false, message: `The pilot needs a task of the type ${type}.` };
		}
		chosen.push(first);
	}
	return { ok: true, tasks: chosen };
}

/**
 * Build the matrix of the experiments.
 *
 * The cells come in the order of the task, then of the model, then of the
 * effort. The identifier of an experiment counts from 0001. The pilot uses
 * the first two efforts.
 */
export function buildPlan(
	tasks: PlanTask[],
	models: string[],
	efforts: string[],
	pilot: boolean,
): PlanResult {
	if (models.length === 0) return { ok: false, message: "The plan needs at least one model." };
	if (efforts.length === 0) return { ok: false, message: "The plan needs at least one effort." };
	const modelError = checkModels(models);
	if (modelError !== null) return { ok: false, message: modelError };
	let selected = tasks;
	let selectedEfforts = efforts;
	if (pilot) {
		if (efforts.length < PILOT_EFFORT_COUNT) {
			return {
				ok: false,
				message: `The pilot needs at least ${PILOT_EFFORT_COUNT} efforts.`,
			};
		}
		const chosen = selectPilot(tasks);
		if (!chosen.ok) return { ok: false, message: chosen.message };
		selected = chosen.tasks;
		selectedEfforts = efforts.slice(0, PILOT_EFFORT_COUNT);
	}
	const cells: PlanCell[] = [];
	const seen = new Set<string>();
	let counter = 1;
	for (const task of selected) {
		for (const model of models) {
			for (const effort of selectedEfforts) {
				const key = cellKey(task.taskId, model, effort);
				if (seen.has(key)) {
					return {
						ok: false,
						message: `The plan holds the cell ${task.taskId}, ${model}, ${effort} twice.`,
					};
				}
				seen.add(key);
				cells.push({
					experimentId: experimentId(counter),
					taskId: task.taskId,
					taskType: task.taskType,
					model,
					effort,
					fixtureChecksum: task.fixtureChecksum,
					promptHash: task.promptHash,
				});
				counter += 1;
			}
		}
	}
	return { ok: true, cells };
}

/**
 * The message that refuses a dirty work tree.
 *
 * The message names the changed files. It is null when the plan may run.
 */
export function dirtyRefusal(changed: string[], allowDirty: boolean): string | null {
	if (allowDirty || changed.length === 0) return null;
	return `The work tree holds changes. Run the plan on a clean tree or use --allow-dirty. Changed files: ${changed.join(", ")}`;
}

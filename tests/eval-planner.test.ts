import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlan, dirtyRefusal } from "../tooling/eval/planner.ts";
import type { PlanTask, TaskType } from "../tooling/eval/types.ts";

/** The models of the pilot. */
const MODELS = [
	"omniroute/minimax/MiniMax-M3.1-Flash",
	"omniroute/cc/claude-haiku-5-5",
	"omniroute/cc/claude-opus-5-5",
];

/** The efforts of the pilot. */
const EFFORTS = ["low", "high"];

/** One task of a test plan. */
function task(taskId: string, taskType: TaskType): PlanTask {
	return {
		taskId,
		taskType,
		fixtureChecksum: `sha256:${taskId}`,
		promptHash: `sha256:${taskId}`,
	};
}

/** The tasks of the pilot. */
function pilotTasks(): PlanTask[] {
	return [
		task("bugfix-001", "bugfix"),
		task("bugfix-002", "bugfix"),
		task("implementation-001", "implementation"),
		task("refactoring-001", "refactoring"),
	];
}

/** The tasks of the full matrix. */
function fullTasks(): PlanTask[] {
	const tasks: PlanTask[] = [];
	for (let index = 1; index <= 30; index += 1) {
		const type: TaskType = index % 3 === 0 ? "implementation" : index % 3 === 1 ? "bugfix" : "refactoring";
		tasks.push(task(`task-${String(index).padStart(3, "0")}`, type));
	}
	return tasks;
}

test("the pilot builds 18 cells", () => {
	const result = buildPlan(pilotTasks(), MODELS, EFFORTS, true);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.cells.length, 18);
});

test("the pilot takes the first task of each type", () => {
	const result = buildPlan(pilotTasks(), MODELS, EFFORTS, true);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(
		[...new Set(result.cells.map((cell) => cell.taskId))],
		["bugfix-001", "implementation-001", "refactoring-001"],
	);
});

test("the full matrix builds 270 cells", () => {
	const result = buildPlan(fullTasks(), MODELS, ["low", "medium", "high"], false);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.cells.length, 270);
});

test("the experiment identifiers are deterministic", () => {
	const first = buildPlan(pilotTasks(), MODELS, EFFORTS, true);
	const second = buildPlan(pilotTasks(), MODELS, EFFORTS, true);
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	if (!first.ok || !second.ok) return;
	assert.deepEqual(
		first.cells.map((cell) => cell.experimentId),
		second.cells.map((cell) => cell.experimentId),
	);
	assert.equal(first.cells[0].experimentId, "exp-0001");
	assert.equal(first.cells[first.cells.length - 1].experimentId, "exp-0018");
});

test("the cells come in the order of the task, the model and the effort", () => {
	const result = buildPlan(pilotTasks(), MODELS, EFFORTS, true);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const first = result.cells[0];
	assert.equal(first.taskId, "bugfix-001");
	assert.equal(first.model, MODELS[0]);
	assert.equal(first.effort, EFFORTS[0]);
	const second = result.cells[1];
	assert.equal(second.taskId, "bugfix-001");
	assert.equal(second.model, MODELS[0]);
	assert.equal(second.effort, EFFORTS[1]);
	const third = result.cells[2];
	assert.equal(third.taskId, "bugfix-001");
	assert.equal(third.model, MODELS[1]);
});

test("the planner refuses a duplicate cell", () => {
	const result = buildPlan(pilotTasks(), [MODELS[0], MODELS[0]], EFFORTS, true);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /twice/);
});

test("the planner refuses a model with a colon", () => {
	const result = buildPlan(pilotTasks(), [`${MODELS[0]}:xhigh`], EFFORTS, true);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /colon/);
});

test("the planner refuses a model with the alias prefix", () => {
	const result = buildPlan(pilotTasks(), ["auto/claude-sonnet"], EFFORTS, true);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /alias/);
});

test("the planner refuses a pilot without a task of every type", () => {
	const result = buildPlan([task("bugfix-001", "bugfix")], MODELS, EFFORTS, true);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /implementation/);
});

test("the planner refuses a pilot with too few efforts", () => {
	const result = buildPlan(pilotTasks(), MODELS, ["low"], true);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /efforts/);
});

test("the dirty refusal is null for an empty list", () => {
	assert.equal(dirtyRefusal([], false), null);
});

test("the dirty refusal is null when the plan may run on a dirty tree", () => {
	assert.equal(dirtyRefusal(["README.md"], true), null);
});

test("the dirty refusal names the changed files", () => {
	const message = dirtyRefusal(["README.md", "tooling/eval/cli.ts"], false);
	assert.notEqual(message, null);
	assert.match(message ?? "", /README\.md/);
	assert.match(message ?? "", /tooling\/eval\/cli\.ts/);
});

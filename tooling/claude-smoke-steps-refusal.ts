/**
 * The steps of the Claude smoke test that check a refusal and the default
 * model.
 *
 * Each step prints one line through the function `report`. The module holds
 * the refusal of a tool list, the refusal of an unknown backend, and the
 * spawn that names no model.
 */

import { claudeProcessOf, newClaudeProcesses } from "./claude-smoke-ledger.ts";
import { answerStartupPrompts } from "./claude-smoke-pane.ts";
import {
	cancelWorker,
	currentClaudeRows,
	delay,
	recordPane,
	recordProcess,
	recordWorkerProcess,
	rememberWorker,
	report,
	type SmokeState,
	textOf,
} from "./claude-smoke-shared.ts";
import { commandLineNamesNoModel, STEP_NAMES } from "./claude-smoke-steps.ts";
import { spawnIds } from "./claude-smoke-steps-one.ts";

/**
 * Step 4: a spawn with a tool list is refused before the launch.
 *
 * The tool list applies to an OMP worker only. The refusal happens before
 * the launch, so no worker and no process starts.
 */
export async function stepToolsRefused(state: SmokeState): Promise<void> {
	const rowsBefore = await currentClaudeRows();
	const refused = await state.host.call("wezterm_spawn_worker", {
		task: "Read baseline.txt.",
		cwd: state.repo,
		backend: "claude",
		tools: ["read", "grep"],
	});
	const text = textOf(refused);
	const rowsAfter = await currentClaudeRows();
	const created = newClaudeProcesses(rowsBefore, rowsAfter);
	if (!text.includes("OMP worker only")) {
		report(
			state,
			"fail",
			STEP_NAMES.toolsRefused,
			`the spawn accepted a tool list: ${text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	if (created.length > 0) {
		report(
			state,
			"fail",
			STEP_NAMES.toolsRefused,
			`the refusal started the process ${created.map((row) => row.processId).join(", ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.toolsRefused,
		`the spawn refused the tool list and started no process: ${text.split("\n")[0]}`,
	);
}

/**
 * Step 5: a spawn with an unknown backend is refused before the launch.
 *
 * The extension never falls back to another backend.
 */
export async function stepUnknownBackend(state: SmokeState): Promise<void> {
	const rowsBefore = await currentClaudeRows();
	const refused = await state.host.call("wezterm_spawn_worker", {
		task: "Read baseline.txt.",
		cwd: state.repo,
		backend: "not-a-backend",
	});
	const text = textOf(refused);
	const rowsAfter = await currentClaudeRows();
	const created = newClaudeProcesses(rowsBefore, rowsAfter);
	if (!text.includes("Unknown backend")) {
		report(
			state,
			"fail",
			STEP_NAMES.unknownBackend,
			`the spawn accepted a backend that the extension does not know: ${text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	if (created.length > 0) {
		report(
			state,
			"fail",
			STEP_NAMES.unknownBackend,
			`the refusal started the process ${created.map((row) => row.processId).join(", ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.unknownBackend,
		`the spawn refused the backend and started no process: ${text.split("\n")[0]}`,
	);
}

/**
 * Step 6: a spawn with no model names no model in the command line.
 *
 * The criteria say that the default model of the user stays. The step
 * starts a worker without a model and reads the command line of the process
 * of that worker.
 */
export async function stepDefaultModel(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything yet.",
		cwd: state.repo,
		label: "claude-smoke-model",
		backend: "claude",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId || ids.paneId === null) {
		report(
			state,
			"fail",
			STEP_NAMES.defaultModel,
			`the spawn returned no worker id or pane id: ${textOf(spawned)}`,
		);
		return;
	}
	recordPane(state, ids.paneId);
	state.workersToCancel.push(ids.workerId);
	rememberWorker(state, ids.workerId);
	await answerStartupPrompts(ids.paneId);
	await recordWorkerProcess(state, ids.workerId);

	const rowsAfter = await currentClaudeRows();
	const own = claudeProcessOf(rowsAfter, ids.workerId);
	if (!own) {
		report(
			state,
			"fail",
			STEP_NAMES.defaultModel,
			`the process table holds no process of the worker ${ids.workerId}`,
		);
		await cancelWorker(state, ids.workerId);
		return;
	}
	recordProcess(state, own.processId);
	if (commandLineNamesNoModel(own.commandLine)) {
		report(
			state,
			"pass",
			STEP_NAMES.defaultModel,
			`the command line of the process ${own.processId} names no model: ${own.commandLine}`,
		);
	} else {
		report(
			state,
			"fail",
			STEP_NAMES.defaultModel,
			`the command line of the process ${own.processId} names a model: ${own.commandLine}`,
		);
	}
	await cancelWorker(state, ids.workerId);
	await delay(2000);
}

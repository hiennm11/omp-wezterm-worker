/**
 * The steps of the Claude smoke test that reuse a worker.
 *
 * Each step prints one line through the function `report`. The module holds
 * the resume and the steering instruction.
 */

import { claudeProcessOf, statusText, waitForStatus } from "./claude-smoke-ledger.ts";
import { paneState } from "./claude-smoke-machine.ts";
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
import { STEP_NAMES } from "./claude-smoke-steps.ts";
import { spawnIds } from "./claude-smoke-steps-one.ts";

/**
 * Step 7: a finished Claude worker resumes in its native session.
 *
 * The CLI refuses a resume while the old process still runs, so the step
 * waits for the process of the source run to go.
 */
export async function stepResume(state: SmokeState): Promise<void> {
	const workerId = state.firstWorkerId;
	if (!workerId) {
		report(state, "not-run", STEP_NAMES.resume, "no worker of the spawn step ran");
		return;
	}
	const deadline = Date.now() + 60_000;
	let ended = false;
	while (Date.now() < deadline) {
		const rows = await currentClaudeRows();
		if (!claudeProcessOf(rows, workerId)) {
			ended = true;
			break;
		}
		await delay(1000);
	}
	if (!ended) {
		report(
			state,
			"fail",
			STEP_NAMES.resume,
			`the process of the worker ${workerId} still runs, so the CLI refuses the resume`,
		);
		return;
	}
	const resumed = await state.host.call("wezterm_worker_resume", {
		workerId,
		message:
			"Read baseline.txt again. Then call the tool whose name ends with wezterm_worker_report. " +
			"Report the state completed and the result RESUME-OK.",
	});
	const text = textOf(resumed);
	const ids = spawnIds(resumed);
	if (!ids.workerId) {
		report(
			state,
			"fail",
			STEP_NAMES.resume,
			`the resume returned no worker id: ${text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	recordPane(state, ids.paneId);
	state.workersToCancel.push(ids.workerId);
	rememberWorker(state, ids.workerId);
	/* A resumed session reuses the plugin directory of its source run, so
	   its process carries the id of the source run. */
	const rows = await currentClaudeRows();
	const own = claudeProcessOf(rows, workerId) ?? claudeProcessOf(rows, ids.workerId);
	if (own) recordProcess(state, own.processId);
	await answerStartupPrompts(ids.paneId ?? -1);
	await recordWorkerProcess(state, workerId);
	await recordWorkerProcess(state, ids.workerId);
	const done = await waitForStatus(state, ids.workerId, "RESUME-OK");
	if (!done.found) {
		report(
			state,
			"fail",
			STEP_NAMES.resume,
			`the resumed worker produced no report: ${done.text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.resume,
		`the worker ${workerId} resumed as ${ids.workerId} and reported RESUME-OK`,
	);
}

/**
 * Step 8: a steering instruction reaches the worker.
 *
 * The instruction goes through the bridge, and the native session queues it.
 * The worker reports STEER-OK.
 */
export async function stepSteer(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for a follow-up instruction. Do not report anything yet.",
		cwd: state.repo,
		label: "claude-smoke-steer",
		backend: "claude",
		model: "haiku",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId || ids.paneId === null) {
		report(state, "fail", STEP_NAMES.steer, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	recordPane(state, ids.paneId);
	state.workersToCancel.push(ids.workerId);
	rememberWorker(state, ids.workerId);
	await answerStartupPrompts(ids.paneId);
	await recordWorkerProcess(state, ids.workerId);
	/* The native submit waits until the session is free. The step waits for
	   the first turn, so the queued instruction starts its own turn. */
	await waitForStatus(state, ids.workerId, "turns     : 1", 120_000);
	await delay(5000);
	const steered = await state.host.call("wezterm_worker_steer", {
		workerId: ids.workerId,
		message:
			"Read baseline.txt. Then call the tool whose name ends with wezterm_worker_report. " +
			"Report the state completed and the result STEER-OK.",
	});
	const text = textOf(steered);
	const done = await waitForStatus(state, ids.workerId, "STEER-OK");
	if (!done.found) {
		report(
			state,
			"fail",
			STEP_NAMES.steer,
			`the steered worker produced no report: ${text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	report(state, "pass", STEP_NAMES.steer, `the worker ${ids.workerId} reported STEER-OK`);
}

/**
 * The state of the pane of the user and of a worker.
 *
 * The function reads the pane list once. A pane that the list does not name
 * is gone. A list that cannot be read gives unknown, and the caller never
 * treats unknown as a closed pane.
 */
export async function paneStateOf(paneId: number): Promise<"present" | "gone" | "unknown"> {
	return paneState(paneId);
}

/**
 * The state of a process in the process table.
 *
 * A process that the table does not name is gone. An empty table means that
 * the table could not be read, and the caller treats it as unknown.
 */
export async function processStateOf(processId: number): Promise<"present" | "gone" | "unknown"> {
	const rows = await currentClaudeRows();
	if (rows.length === 0) return "unknown";
	return rows.some((row) => row.processId === processId) ? "present" : "gone";
}

/**
 * The text of the status of a worker, for the evidence of a step.
 */
export async function statusOf(state: SmokeState, workerId: string): Promise<string> {
	const text = await statusText(state, workerId);
	return text.split("\n")[0] ?? "";
}

/**
 * Cancel a worker and remove it from the list of the workers to cancel.
 *
 * The function is exported for the cleanup of the smoke test.
 */
export { cancelWorker };

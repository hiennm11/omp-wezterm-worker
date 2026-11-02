/**
 * The steps of the Claude smoke test that cancel a worker.
 *
 * Each step prints one line through the function `report`. The module holds
 * the cancel of a worker and the history of Claude Code outside the
 * extension.
 */

import { claudeSessionFolderOf } from "./claude-smoke-home.ts";
import { claudeProcessOf, nativeSessionIdOf, statusText } from "./claude-smoke-ledger.ts";
import { paneState } from "./claude-smoke-machine.ts";
import { answerStartupPrompts } from "./claude-smoke-pane.ts";
import {
	cancelWorker,
	currentClaudeRows,
	currentPanes,
	delay,
	projectEntries,
	recordAllDescendants,
	recordPane,
	recordProcess,
	recordWorkerProcess,
	rememberWorker,
	report,
	type SmokeState,
	settingsHash,
	textOf,
} from "./claude-smoke-shared.ts";
import { homeDifference, STEP_NAMES } from "./claude-smoke-steps.ts";
import { spawnIds } from "./claude-smoke-steps-one.ts";

/**
 * Step 9: a cancel ends the worker, its pane, and its process.
 *
 * The step starts two workers of Claude Code. It cancels one of them. The
 * pane of the cancelled worker must be gone, its process must be gone, the
 * other worker must still run, and the panes of the user must stay.
 */
export async function stepCancel(state: SmokeState): Promise<void> {
	const keeper = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything yet.",
		cwd: state.repo,
		label: "claude-smoke-keeper",
		backend: "claude",
		model: "haiku",
		placement: "tab",
	});
	const keeperIds = spawnIds(keeper);
	if (!keeperIds.workerId || keeperIds.paneId === null) {
		report(state, "fail", STEP_NAMES.cancel, `the keeper spawn returned no worker id: ${textOf(keeper)}`);
		return;
	}
	recordPane(state, keeperIds.paneId);
	state.workersToCancel.push(keeperIds.workerId);
	rememberWorker(state, keeperIds.workerId);
	await answerStartupPrompts(keeperIds.paneId);
	await recordWorkerProcess(state, keeperIds.workerId);

	const doomed = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything yet.",
		cwd: state.repo,
		label: "claude-smoke-cancel",
		backend: "claude",
		model: "haiku",
		placement: "tab",
	});
	const doomedIds = spawnIds(doomed);
	if (!doomedIds.workerId || doomedIds.paneId === null) {
		report(state, "fail", STEP_NAMES.cancel, `the second spawn returned no worker id: ${textOf(doomed)}`);
		await cancelWorker(state, keeperIds.workerId);
		return;
	}
	recordPane(state, doomedIds.paneId);
	state.workersToCancel.push(doomedIds.workerId);
	rememberWorker(state, doomedIds.workerId);
	await answerStartupPrompts(doomedIds.paneId);

	/* The step reads the process of the worker that it cancels, so it can
	   prove that the process is gone after the cancel. */
	const rowsBefore = await currentClaudeRows();
	const doomedProcess = claudeProcessOf(rowsBefore, doomedIds.workerId);
	const keeperProcess = claudeProcessOf(rowsBefore, keeperIds.workerId);
	if (doomedProcess) recordProcess(state, doomedProcess.processId);
	if (keeperProcess) recordProcess(state, keeperProcess.processId);
	/* The cancel ends the helper of the worker, and the shell of the last
	   command then loses its parent. The step reads the descendants before
	   the cancel, so the cleanup can end them by their id. */
	await recordAllDescendants(state);

	const cancelled = await state.host.call("wezterm_worker_cancel", { workerId: doomedIds.workerId });
	const cancelText = textOf(cancelled);
	const deadline = Date.now() + 60_000;
	let paneGone = false;
	while (Date.now() < deadline) {
		if ((await paneState(doomedIds.paneId)) === "gone") {
			paneGone = true;
			break;
		}
		await delay(1000);
	}
	const rowsAfter = await currentClaudeRows();
	const processGone =
		doomedProcess === null || !rowsAfter.some((row) => row.processId === doomedProcess.processId);
	const keeperAlive =
		keeperProcess === null || rowsAfter.some((row) => row.processId === keeperProcess.processId);
	const keeperPane = await paneState(keeperIds.paneId);
	const userPanesStay = await userPanesStayOf(state);

	if (!cancelText.includes("cancelled")) {
		report(
			state,
			"fail",
			STEP_NAMES.cancel,
			`the cancel did not confirm the stop: ${cancelText.replace(/\n/g, " | ")}`,
		);
		await cancelWorker(state, keeperIds.workerId);
		return;
	}
	if (!paneGone) {
		report(
			state,
			"fail",
			STEP_NAMES.cancel,
			`the pane ${doomedIds.paneId} of the cancelled worker is still open`,
		);
		await cancelWorker(state, keeperIds.workerId);
		return;
	}
	if (!processGone) {
		report(
			state,
			"fail",
			STEP_NAMES.cancel,
			`the process ${doomedProcess?.processId} of the cancelled worker still runs`,
		);
		await cancelWorker(state, keeperIds.workerId);
		return;
	}
	if (!keeperAlive || keeperPane !== "present") {
		report(
			state,
			"fail",
			STEP_NAMES.cancel,
			`the cancel took the other worker: its process ${keeperProcess?.processId ?? "unknown"} and its pane ${keeperIds.paneId} (${keeperPane})`,
		);
		await cancelWorker(state, keeperIds.workerId);
		return;
	}
	if (!userPanesStay.ok) {
		report(state, "fail", STEP_NAMES.cancel, `the cancel took a pane of the user: ${userPanesStay.evidence}`);
		await cancelWorker(state, keeperIds.workerId);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.cancel,
		`the cancel of ${doomedIds.workerId} closed the pane ${doomedIds.paneId} and ended the process ${doomedProcess?.processId ?? "unknown"}; ` +
			`the worker ${keeperIds.workerId} and the panes of the user survived`,
	);
	state.cancelledSessionId = nativeSessionIdOf(state.stateDir, doomedIds.workerId);
	await cancelWorker(state, keeperIds.workerId);
	await delay(2000);
}

/**
 * The panes of the user that survived the run.
 *
 * The function reads the pane list once. Every pane of the user before the
 * run must still exist after the run.
 */
async function userPanesStayOf(state: SmokeState): Promise<{ ok: boolean; evidence: string }> {
	const panes = await currentPanes();
	if (panes === null) {
		return { ok: false, evidence: "the pane list cannot be read, so the panes of the user are unknown" };
	}
	const gone = state.userPanesBefore.filter((pane) => !panes.includes(pane));
	if (gone.length > 0) return { ok: false, evidence: `the panes ${gone.join(", ")} of the user are gone` };
	return { ok: true, evidence: `the panes ${state.userPanesBefore.join(", ")} of the user survive` };
}

/**
 * Step 10: the history of Claude Code outside the extension stays.
 *
 * The step reads the folder of the session of the cancelled worker and the
 * settings of Claude Code. The folder must exist, and the settings must
 * keep their hash.
 */
export async function stepExternalHistory(state: SmokeState): Promise<void> {
	const sessionId = state.cancelledSessionId;
	if (!sessionId) {
		report(
			state,
			"not-run",
			STEP_NAMES.externalHistory,
			"no worker was cancelled, so no session folder was checked",
		);
		return;
	}
	const folder = claudeSessionFolderOf(sessionId);
	if (!folder) {
		report(
			state,
			"fail",
			STEP_NAMES.externalHistory,
			`the folder of the session ${sessionId} is gone under the home folder of Claude Code`,
		);
		return;
	}
	const hashAfter = settingsHash();
	const entriesAfter = projectEntries();
	const difference = homeDifference(
		state.settingsHashBefore,
		hashAfter,
		state.projectEntriesBefore,
		entriesAfter,
	);
	if (difference.settingsChanged) {
		report(
			state,
			"fail",
			STEP_NAMES.externalHistory,
			`the settings of Claude Code changed: ${state.settingsHashBefore} -> ${hashAfter}`,
		);
		return;
	}
	if (difference.missingEntries.length > 0) {
		report(
			state,
			"fail",
			STEP_NAMES.externalHistory,
			`the entries ${difference.missingEntries.join(", ")} of the folder of the sessions are gone`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.externalHistory,
		`the folder ${folder} of the session ${sessionId} stays; the settings of Claude Code keep the hash ${hashAfter}; ` +
			`the folder of the sessions gained the entries ${difference.addedEntries.join(", ") || "none"}`,
	);
}

/**
 * The text of the status of a worker, for the evidence of a step.
 */
export async function statusOf(state: SmokeState, workerId: string): Promise<string> {
	const text = await statusText(state, workerId);
	return text.split("\n")[0] ?? "";
}

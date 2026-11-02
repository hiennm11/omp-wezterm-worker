/**
 * The steps of the Codex smoke test that need a worker of Codex.
 *
 * Each step prints one line through the function `report`. The module holds
 * the steps that start a worker and read the state of that worker.
 */

import { identityOf, newPanes, newProcesses, spawnIds, waitForStatus } from "./codex-smoke-ledger.ts";
import { appServerProcessOf, tuiProcessOf } from "./codex-smoke-machine.ts";
import {
	authHash,
	configHash,
	currentCodexRows,
	currentPanes,
	currentPaneText,
	recordThread,
	report,
	type SmokeState,
	textOf,
} from "./codex-smoke-shared.ts";
import { REPORT_INSTRUCTION, STEP_NAMES, showsCodexScreen } from "./codex-smoke-steps.ts";

/**
 * Step 1: a spawn opens two panes, the worker reports, and a cancel ends the
 * worker of a second spawn.
 */
export async function stepSpawnAndCancel(state: SmokeState): Promise<void> {
	const panesBefore = await currentPanes();

	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: `Read baseline.txt. ${REPORT_INSTRUCTION}`,
		cwd: state.repo,
		label: "codex-smoke",
		backend: "codex",
		placement: "tab",
	});
	const first = spawnIds(spawned);
	if (!first.workerId || first.paneId === null) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the spawn returned no worker id or pane id: ${textOf(spawned)}`,
		);
		return;
	}
	state.firstWorkerId = first.workerId;
	state.firstTuiPane = first.paneId;

	const panesAfter = await currentPanes();
	const ownPanes = newPanes(panesBefore, panesAfter);
	for (const pane of ownPanes) state.ownPanes.add(pane);
	const identity = identityOf(state.stateDir, first.workerId);
	state.firstPort = identity.port;
	recordThread(state, identity.threadId);
	const rowsAfter = await currentCodexRows();
	const server = identity.port === null ? null : appServerProcessOf(rowsAfter, identity.port);
	if (server) state.ownProcesses.add(server.processId);

	const screen = await currentPaneText(first.paneId);
	if (ownPanes.length < 2) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the spawn opened ${ownPanes.length} pane(s), not 2: ${ownPanes.join(", ")}`,
		);
		return;
	}
	if (!showsCodexScreen(screen)) {
		report(state, "fail", STEP_NAMES.spawnAndCancel, "the pane of the TUI shows no Codex screen");
		return;
	}

	const completed = await waitForStatus(state, first.workerId, "COMPLETED");
	if (!completed.found) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the worker did not complete with SMOKE-OK: ${completed.text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	if (!completed.text.includes("SMOKE-OK")) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the worker completed without the result SMOKE-OK: ${completed.text.replace(/\n/g, " | ")}`,
		);
		return;
	}

	/* A third worker stays alive during the cancel. A worker that ends on
	   its own closes its own panes, so the first worker cannot prove that the
	   cancel spared the panes of another worker. */
	const keeper = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything.",
		cwd: state.repo,
		label: "codex-smoke-keeper",
		backend: "codex",
		placement: "tab",
	});
	const keeperIds = spawnIds(keeper);
	if (!keeperIds.workerId || keeperIds.paneId === null) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the keeper spawn returned no worker id: ${textOf(keeper)}`,
		);
		return;
	}
	state.workersToCancel.push(keeperIds.workerId);
	const keeperIdentity = identityOf(state.stateDir, keeperIds.workerId);
	recordThread(state, keeperIdentity.threadId);
	state.liveWorkerId = keeperIds.workerId;
	state.livePort = keeperIdentity.port;

	const second = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything.",
		cwd: state.repo,
		label: "codex-smoke-cancel",
		backend: "codex",
		placement: "tab",
	});
	const secondIds = spawnIds(second);
	if (!secondIds.workerId || secondIds.paneId === null) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the second spawn returned no worker id: ${textOf(second)}`,
		);
		return;
	}
	state.workersToCancel.push(secondIds.workerId);
	const panesBeforeCancel = await currentPanes();
	for (const pane of newPanes(panesBefore, panesBeforeCancel)) state.ownPanes.add(pane);
	const secondIdentity = identityOf(state.stateDir, secondIds.workerId);
	recordThread(state, secondIdentity.threadId);
	state.cancelledThreadId = secondIdentity.threadId;
	const rowsBeforeCancel = await currentCodexRows();
	const secondServer =
		secondIdentity.port === null ? null : appServerProcessOf(rowsBeforeCancel, secondIdentity.port);
	if (secondServer) state.ownProcesses.add(secondServer.processId);
	const secondServerPid = secondServer?.processId ?? null;

	const cancelled = await state.host.call("wezterm_worker_cancel", { workerId: secondIds.workerId });
	const cancelText = textOf(cancelled);
	const afterCancel = await waitForStatus(state, secondIds.workerId, "CANCELLED", 60_000);
	const panesAfterCancel = await currentPanes();
	const rowsAfterCancel = await currentCodexRows();

	const secondPanesGone =
		!panesAfterCancel.includes(secondIds.paneId) &&
		(secondIdentity.serverPaneId === null || !panesAfterCancel.includes(secondIdentity.serverPaneId));
	const processGone =
		secondServerPid === null || !rowsAfterCancel.some((row) => row.processId === secondServerPid);
	const keeperPanesStay =
		panesAfterCancel.includes(keeperIds.paneId) &&
		(keeperIdentity.serverPaneId === null || panesAfterCancel.includes(keeperIdentity.serverPaneId));
	const userPanesStay = panesBefore.every((pane) => panesAfterCancel.includes(pane));

	if (!cancelText.includes("cancelled") || !afterCancel.found) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the cancel did not confirm the stop: ${cancelText.replace(/\n/g, " | ")}`,
		);
		return;
	}
	if (!secondPanesGone) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the panes of the cancelled worker are still there: ${panesAfterCancel.join(", ")}`,
		);
		return;
	}
	if (!processGone) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the app server ${secondServerPid} of the cancelled worker still runs`,
		);
		return;
	}
	if (!keeperPanesStay || !userPanesStay) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndCancel,
			`the cancel took a pane of another worker or of the user: the panes after the cancel are ${panesAfterCancel.join(", ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.spawnAndCancel,
		`worker ${first.workerId} reported SMOKE-OK; the spawn opened panes ${ownPanes.join(", ")}; ` +
			`the cancel of ${secondIds.workerId} closed its panes and ended its app server ${secondServerPid}; ` +
			`the panes of the worker ${keeperIds.workerId} and of the user survived`,
	);
}

/**
 * Step 2: the config and the credentials of Codex keep their hash, and the
 * command line of the TUI names no model.
 */
export async function stepNativeConfig(state: SmokeState): Promise<void> {
	const config = configHash();
	const auth = authHash();
	if (config !== state.configHashBefore || auth !== state.authHashBefore) {
		report(
			state,
			"fail",
			STEP_NAMES.nativeConfig,
			`the config of Codex changed: ${state.configHashBefore.slice(0, 12)} -> ${config.slice(0, 12)}; ` +
				`the credentials changed: ${state.authHashBefore.slice(0, 12)} -> ${auth.slice(0, 12)}`,
		);
		return;
	}
	if (state.livePort === null) {
		report(
			state,
			"fail",
			STEP_NAMES.nativeConfig,
			"the live worker holds no port, so the command line of the TUI is unknown",
		);
		return;
	}
	const rows = await currentCodexRows();
	const tui = tuiProcessOf(rows, state.livePort);
	if (!tui) {
		report(state, "fail", STEP_NAMES.nativeConfig, "the process of the TUI is not in the process table");
		return;
	}
	if (/(^|\s)-m(\s|=|$)/.test(tui.commandLine)) {
		report(
			state,
			"fail",
			STEP_NAMES.nativeConfig,
			`the command line of the TUI names a model: ${tui.commandLine}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.nativeConfig,
		`the config of Codex keeps the hash ${config.slice(0, 12)}; the credentials keep the hash ${auth.slice(0, 12)}; ` +
			`the command line of the TUI names no model: ${tui.commandLine.slice(0, 140)}`,
	);
}

/**
 * Step 3: a spawn with a tool list is refused before the launch.
 */
export async function stepToolListRefused(state: SmokeState): Promise<void> {
	const panesBefore = await currentPanes();
	const rowsBefore = await currentCodexRows();
	const refused = await state.host.call("wezterm_spawn_worker", {
		task: "Read baseline.txt.",
		cwd: state.repo,
		backend: "codex",
		tools: ["read"],
	});
	const text = textOf(refused);
	const panesAfter = await currentPanes();
	const rowsAfter = await currentCodexRows();
	if (!text.includes("OMP worker only")) {
		report(
			state,
			"fail",
			STEP_NAMES.toolListRefused,
			`the spawn accepted a tool list: ${text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	const panes = newPanes(panesBefore, panesAfter);
	const processes = newProcesses(rowsBefore, rowsAfter);
	if (panes.length > 0 || processes.length > 0) {
		report(
			state,
			"fail",
			STEP_NAMES.toolListRefused,
			`the refusal started a pane ${panes.join(", ")} or a process ${processes.map((p) => p.processId).join(", ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.toolListRefused,
		`the spawn refused the tool list and started no pane and no process: ${text.split("\n")[0]}`,
	);
}

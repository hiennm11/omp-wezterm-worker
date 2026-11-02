/**
 * The steps of the Codex smoke test that read the pane of a worker.
 *
 * Each step prints one line through the function `report`. The module holds
 * the steps that play the part of the person in the pane of a worker.
 */

import { rolloutFiles } from "./codex-smoke-home.ts";
import { executionRows, newPanes, newProcesses, spawnIds, statusText } from "./codex-smoke-ledger.ts";
import {
	cancelWorker,
	currentCodexRows,
	currentPanes,
	delay,
	report,
	type SmokeState,
	sendText,
	textOf,
} from "./codex-smoke-shared.ts";
import { cycleCountOf, STEP_NAMES } from "./codex-smoke-steps.ts";

/**
 * Step 6: a task typed into the TUI starts a new cycle of the run.
 *
 * The step types into the pane of a running worker, the way a person does,
 * and then reads the number of cycles of the run.
 */
export async function stepDirectInput(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for a task from the person. Do not report anything yet.",
		cwd: state.repo,
		label: "codex-smoke-direct",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId || ids.paneId === null) {
		report(state, "fail", STEP_NAMES.directInput, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	state.workersToCancel.push(ids.workerId);
	try {
		const before = await statusText(state, ids.workerId);
		const cyclesBefore = cycleCountOf(before, ids.workerId) ?? 0;
		const sent = await sendText(ids.paneId, "Reply with the word DIRECT-OK only.");
		if (!sent) {
			report(state, "fail", STEP_NAMES.directInput, "the WezTerm CLI refused the text of the task");
			return;
		}
		const deadline = Date.now() + 120_000;
		let cyclesAfter = cyclesBefore;
		while (Date.now() < deadline) {
			await delay(2000);
			const text = await statusText(state, ids.workerId);
			cyclesAfter = cycleCountOf(text, ids.workerId) ?? cyclesBefore;
			if (cyclesAfter > cyclesBefore) break;
		}
		if (cyclesAfter <= cyclesBefore) {
			report(
				state,
				"fail",
				STEP_NAMES.directInput,
				`the status shows ${cyclesAfter} cycle(s) after the task, not more than ${cyclesBefore}`,
			);
			return;
		}
		report(
			state,
			"pass",
			STEP_NAMES.directInput,
			`the task typed into the pane ${ids.paneId} opened a new cycle: ${cyclesBefore} -> ${cyclesAfter}`,
		);
	} finally {
		await cancelWorker(state, ids.workerId);
	}
}

/**
 * Step 7: the ledger holds a row for a shell command of the worker.
 *
 * The step reads the table `executions` of the run while the command runs
 * and after it ends.
 */
export async function stepExecutionEvidence(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Run a shell command that waits 30 seconds. Then reply DONE.",
		cwd: state.repo,
		label: "codex-smoke-exec",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId) {
		report(
			state,
			"fail",
			STEP_NAMES.executionEvidence,
			`the spawn returned no worker id: ${textOf(spawned)}`,
		);
		return;
	}
	state.workersToCancel.push(ids.workerId);
	try {
		const deadline = Date.now() + 120_000;
		let open = false;
		let settled = false;
		let rows = executionRows(state.stateDir, ids.workerId);
		while (Date.now() < deadline) {
			rows = executionRows(state.stateDir, ids.workerId);
			if (rows.some((row) => row.state === "open")) open = true;
			if (open && rows.length > 0 && rows.every((row) => row.state === "settled")) {
				settled = true;
				break;
			}
			await delay(1000);
		}
		if (!open) {
			report(
				state,
				"fail",
				STEP_NAMES.executionEvidence,
				`the table executions holds no open row: ${JSON.stringify(rows)}`,
			);
			return;
		}
		if (!settled) {
			report(
				state,
				"fail",
				STEP_NAMES.executionEvidence,
				`the open row did not settle: ${JSON.stringify(rows)}`,
			);
			return;
		}
		report(
			state,
			"pass",
			STEP_NAMES.executionEvidence,
			`the run ${ids.workerId} holds ${rows.length} row(s): ${rows.map((row) => `${row.toolName ?? "unknown"}=${row.state}`).join(", ")}`,
		);
	} finally {
		await cancelWorker(state, ids.workerId);
	}
}

/**
 * Step 9: the daemon of the user survives, and the rollout file of the
 * cancelled thread stays on the disk.
 */
export async function stepDaemonAndRollout(state: SmokeState): Promise<void> {
	const rows = await currentCodexRows();
	const daemonsAfter = rows
		.filter(
			(row) => row.commandLine.includes("--managed-daemon") || row.commandLine.includes("app-server daemon"),
		)
		.map((row) => row.processId);
	const survived = state.daemonBefore.every((pid) => daemonsAfter.includes(pid));
	if (!survived) {
		report(
			state,
			"fail",
			STEP_NAMES.daemonAndRollout,
			`the daemon of the user changed: ${state.daemonBefore.join(", ")} -> ${daemonsAfter.join(", ")}`,
		);
		return;
	}
	if (!state.cancelledThreadId) {
		report(
			state,
			"fail",
			STEP_NAMES.daemonAndRollout,
			"no thread was cancelled, so no rollout file was checked",
		);
		return;
	}
	const cancelledThreadId = state.cancelledThreadId;
	const rollout = rolloutFiles().find((file) => file.includes(cancelledThreadId));
	if (!rollout) {
		report(
			state,
			"fail",
			STEP_NAMES.daemonAndRollout,
			`the rollout file of the cancelled thread ${cancelledThreadId} is gone`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.daemonAndRollout,
		`the daemon of the user keeps the process ids ${daemonsAfter.join(", ")}; the rollout file ${rollout} stays on the disk`,
	);
}

/**
 * Step 10: a spawn with an unknown backend is refused before the launch.
 */
export async function stepUnknownBackend(state: SmokeState): Promise<void> {
	const panesBefore = await currentPanes();
	const rowsBefore = await currentCodexRows();
	const refused = await state.host.call("wezterm_spawn_worker", {
		task: "Read baseline.txt.",
		cwd: state.repo,
		backend: "not-a-backend",
	});
	const text = textOf(refused);
	const panesAfter = await currentPanes();
	const rowsAfter = await currentCodexRows();
	if (!text.includes("Unknown backend")) {
		report(
			state,
			"fail",
			STEP_NAMES.unknownBackend,
			`the spawn accepted an unknown backend: ${text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	const panes = newPanes(panesBefore, panesAfter);
	const processes = newProcesses(rowsBefore, rowsAfter);
	if (panes.length > 0 || processes.length > 0) {
		report(
			state,
			"fail",
			STEP_NAMES.unknownBackend,
			`the refusal started a pane ${panes.join(", ")} or a process ${processes.map((row) => row.processId).join(", ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.unknownBackend,
		`the spawn refused the backend and started no pane and no process: ${text.split("\n")[0]}`,
	);
}

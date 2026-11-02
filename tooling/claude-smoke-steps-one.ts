/**
 * The steps of the Claude smoke test that start a worker.
 *
 * Each step prints one line through the function `report`. The module holds
 * the spawn, the binding of the report, and the usage.
 */

import {
	bridgeTextOf,
	claudeProcessOf,
	nativeSessionIdOf,
	newClaudeProcesses,
	reportTextOf,
	statusText,
	waitForStatus,
} from "./claude-smoke-ledger.ts";
import { answerStartupPrompts } from "./claude-smoke-pane.ts";
import {
	currentClaudeRows,
	recordPane,
	recordProcess,
	rememberWorker,
	report,
	type SmokeState,
	textOf,
} from "./claude-smoke-shared.ts";
import {
	lastTurnIdOf,
	REPORT_INSTRUCTION,
	reportBindsToCycle,
	reportOf,
	STEP_NAMES,
} from "./claude-smoke-steps.ts";

/** The model that the smoke test uses when it names one. */
export const SMOKE_MODEL = "haiku";

/** The ids that a spawn tool returns. */
export interface SpawnIds {
	/** The id of the run. */
	workerId: string | null;
	/** The id of the pane that the run opened. */
	paneId: number | null;
}

/** Read the ids of a spawn result. */
export function spawnIds(result: { details?: unknown }): SpawnIds {
	const details = result.details as { workerId?: unknown; paneId?: unknown } | undefined;
	return {
		workerId: typeof details?.workerId === "string" ? details.workerId : null,
		paneId: typeof details?.paneId === "number" ? details.paneId : null,
	};
}

/**
 * Step 1: a spawn starts a worker, and the worker reports SMOKE-OK.
 *
 * The step starts a worker of Claude Code, answers the startup questions of
 * the session, and waits for the report of the worker.
 */
export async function stepSpawnAndReport(state: SmokeState): Promise<void> {
	const rowsBefore = await currentClaudeRows();
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: REPORT_INSTRUCTION,
		cwd: state.repo,
		label: "claude-smoke",
		backend: "claude",
		model: SMOKE_MODEL,
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId || ids.paneId === null) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndReport,
			`the spawn returned no worker id or pane id: ${textOf(spawned)}`,
		);
		return;
	}
	recordPane(state, ids.paneId);
	state.workersToCancel.push(ids.workerId);
	rememberWorker(state, ids.workerId);
	state.firstWorkerId = ids.workerId;

	/* The process of the worker starts with the pane. The step records its
	   id, so the cleanup can end it by id and never by a name. */
	const rowsAfter = await currentClaudeRows();
	const own = claudeProcessOf(rowsAfter, ids.workerId);
	if (own) recordProcess(state, own.processId);
	const created = newClaudeProcesses(rowsBefore, rowsAfter);
	const foreign = created.filter((row) => row.processId !== own?.processId);
	if (foreign.length > 0) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndReport,
			`the spawn started the process ${foreign.map((row) => row.processId).join(", ")} that runs no worker of the smoke test`,
		);
		return;
	}

	await answerStartupPrompts(ids.paneId);
	const completed = await waitForStatus(state, ids.workerId, "SMOKE-OK");
	if (!completed.found) {
		report(
			state,
			"fail",
			STEP_NAMES.spawnAndReport,
			`the worker did not report SMOKE-OK: ${completed.text.replace(/\n/g, " | ")}`,
		);
		return;
	}
	state.firstSessionId = nativeSessionIdOf(state.stateDir, ids.workerId);
	report(
		state,
		"pass",
		STEP_NAMES.spawnAndReport,
		`worker ${ids.workerId} started in pane ${ids.paneId}; the process ${own?.processId ?? "unknown"} of Claude Code runs; the worker reported SMOKE-OK`,
	);
}

/**
 * Step 2: the report of the run binds to the cycle that produced it.
 *
 * The step reads the report file of the run and the status of the run. The
 * report must name the cycle that the run delivered last. A report with no
 * cycle binds to no cycle, and the supervisor must not finish the run with
 * it.
 */
export async function stepReportBindsToCycle(state: SmokeState): Promise<void> {
	const workerId = state.firstWorkerId;
	if (!workerId) {
		report(state, "not-run", STEP_NAMES.reportBindsToCycle, "no worker of the spawn step ran");
		return;
	}
	const text = reportTextOf(state.stateDir, workerId);
	if (text.length === 0) {
		report(state, "fail", STEP_NAMES.reportBindsToCycle, `the run ${workerId} saved no report file`);
		return;
	}
	const line = reportOf(text, workerId);
	if (!line) {
		report(
			state,
			"fail",
			STEP_NAMES.reportBindsToCycle,
			`the report file holds no report of the run ${workerId}`,
		);
		return;
	}
	/* The bridge log holds the observations of the run. The last turn that
	   it names is the cycle that the run delivered last. */
	const lastTurn = lastTurnIdOf(bridgeTextOf(state.stateDir, workerId));
	const binds = reportBindsToCycle(line.cycleId, lastTurn);
	const status = await statusText(state, workerId);
	const ends = /\bCOMPLETED\b/.test(status);
	if (!binds) {
		report(
			state,
			"fail",
			STEP_NAMES.reportBindsToCycle,
			`the report names the cycle ${line.cycleId ?? "none"} and the run delivered the cycle ${lastTurn ?? "none"}`,
		);
		return;
	}
	if (!ends) {
		report(
			state,
			"fail",
			STEP_NAMES.reportBindsToCycle,
			`the worker did not end: ${status.replace(/\n/g, " | ")}`,
		);
		return;
	}
	report(
		state,
		"pass",
		STEP_NAMES.reportBindsToCycle,
		`the report of the run ${workerId} names the cycle ${line.cycleId}, the run delivered that cycle, and the worker ended with ${line.state}`,
	);
}

/**
 * Step 3: the finished native worker keeps its measured usage.
 *
 * A finished native run keeps the counts that the native CLI reported. The
 * status of a finished worker must show them, and never an unknown usage.
 */
export async function stepUsage(state: SmokeState): Promise<void> {
	const workerId = state.firstWorkerId;
	if (!workerId) {
		report(state, "not-run", STEP_NAMES.usage, "no worker of the spawn step ran");
		return;
	}
	const usage = await statusText(state, workerId);
	if (!/tokens, measured \(/.test(usage)) {
		report(
			state,
			"fail",
			STEP_NAMES.usage,
			`the finished native worker lost its measured usage: ${usage.replace(/\n/g, " | ")}`,
		);
		return;
	}
	const line = usage.split("\n").find((row) => row.includes("tokens"));
	report(state, "pass", STEP_NAMES.usage, line?.trim() ?? "the status shows a measured usage");
}

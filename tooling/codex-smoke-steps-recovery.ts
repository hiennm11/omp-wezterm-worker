/**
 * The steps of the Codex smoke test that need a second session.
 *
 * The recovery step starts a second Node program. That program has its own
 * host on the state directory of the smoke test, and it takes the worker
 * over. The program prints one JSON line with its facts, so the step can
 * read them.
 *
 * The resume step continues the thread of a finished worker. The two steps
 * cover the criteria 12 and 13 of issue 5.
 */

import { join } from "node:path";

import { rolloutTurnCount } from "./codex-smoke-home.ts";
import { completedReportCount, identityOf, spawnIds, statusText } from "./codex-smoke-ledger.ts";
import { runSecond } from "./codex-smoke-second-run.ts";
import {
	cancelWorker,
	currentCodexRows,
	currentPanes,
	delay,
	recordPanes,
	recordThread,
	report,
	type SmokeState,
	textOf,
} from "./codex-smoke-shared.ts";
import { REPORT_INSTRUCTION, STEP_NAMES } from "./codex-smoke-steps.ts";

/**
 * The number of the app servers of Codex on the machine.
 *
 * The function counts the processes of the Codex program that run an app
 * server. The shared daemon of the user runs no app server of a port, so it
 * stays outside the count.
 */
function appServerCount(rows: Array<{ commandLine: string }>): number {
	return rows.filter((row) => row.commandLine.includes("app-server --listen ws://")).length;
}

/**
 * Step 11: the recovery of a running Codex worker by a second session.
 *
 * The step starts a worker that runs a long command. The first host then
 * releases the worker, and the second host takes it over. The step shows
 * that the worker keeps its id, that no second worker starts, that the app
 * server stays the same, that the steer of the second host reaches the
 * thread, and that the report of the worker reaches the second host.
 */
export async function stepRecovery(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Run a shell command that waits 60 seconds.",
		cwd: state.repo,
		label: "codex-smoke-recovery",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId) {
		report(state, "fail", STEP_NAMES.recovery, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	state.workersToCancel.push(ids.workerId);
	const identity = identityOf(state.stateDir, ids.workerId);
	recordPanes(state, ids.paneId, identity);
	recordThread(state, identity.threadId);
	if (identity.port === null || !identity.threadId) {
		report(state, "fail", STEP_NAMES.recovery, "the worker holds no thread, so no recovery can run");
		return;
	}

	const serversBefore = appServerCount(await currentCodexRows());
	const workerId = ids.workerId;

	/* The first host gives the authority away. The worker keeps running. */
	const released = await state.host.call("wezterm_worker_release", { workerId });
	const releaseText = textOf(released);
	if (!releaseText.includes("supervision") || !releaseText.includes("stopped")) {
		report(
			state,
			"fail",
			STEP_NAMES.recovery,
			`the first host could not release the worker: ${releaseText.replace(/\n/g, " | ")}`,
		);
		return;
	}

	/* The first host holds no run state after the release, so a steer of the
	   first host must fail. */
	const firstSteer = await state.host.call("wezterm_worker_steer", {
		workerId,
		message: "Reply with the word FIRST-OK only.",
	});
	const firstSteerText = textOf(firstSteer);
	const firstSteerFailed =
		firstSteer.isError === true ||
		firstSteerText.includes("released") ||
		firstSteerText.includes("does not own");

	const second = await runSecond(
		state.stateDir,
		workerId,
		"Reply with the word SECOND-OK only. Then find the tool wezterm_worker_report with ALL_TOOLS, " +
			"call it, and report the state completed with the result RECOVERY-OK.",
	);
	if (!second.facts) {
		report(state, "fail", STEP_NAMES.recovery, `the second program failed: ${second.error}`);
		return;
	}
	const facts = second.facts;

	const serversAfter = appServerCount(await currentCodexRows());
	const status = await statusText(state, workerId);
	const firstStatus = status.split("\n").find((line) => line.startsWith(`${workerId}  `)) ?? "";

	const parts: string[] = [];
	let failed = false;

	if (!facts.taken) {
		parts.push(`the takeover was refused: ${facts.takeover}`);
		failed = true;
	} else {
		parts.push("the second session took the worker over");
	}
	if (facts.workerCount !== 1) {
		parts.push(`the second session holds ${facts.workerCount} workers, not 1`);
		failed = true;
	} else {
		parts.push("no second worker exists");
	}
	if (serversBefore !== serversAfter) {
		parts.push(`the number of app servers moved from ${serversBefore} to ${serversAfter}`);
		failed = true;
	} else {
		parts.push(`the number of app servers stayed ${serversAfter}`);
	}
	if (facts.steerStatus !== "COMPLETED") {
		parts.push(`the worker stayed ${facts.steerStatus ?? "unknown"} after the steer of the second host`);
		failed = true;
	} else {
		parts.push("the worker reached COMPLETED through the second host");
	}
	if (facts.result === null) {
		parts.push("no report reached the second host");
		failed = true;
	} else {
		parts.push(`the report ${facts.result} reached the second host`);
	}
	if (!firstSteerFailed) {
		parts.push("the steer of the first host did not fail");
		failed = true;
	} else {
		parts.push("the first host holds no run state and its steer failed");
	}

	report(state, failed ? "fail" : "pass", STEP_NAMES.recovery, parts.join("; "));
	void firstStatus;
	/* The first host released the worker, so it cannot cancel it. The
	   cleanup of the smoke test ends the worker of the second session, and
	   it closes the panes that this step recorded. */
	state.workersToCancel = state.workersToCancel.filter((id) => id !== workerId);
}

/**
 * Step 12: the resume of a finished Codex worker.
 *
 * The step starts a worker and waits for its report. The step then resumes
 * the worker with a short task. The step shows that the resumed worker keeps
 * the thread of the source worker, that the thread holds the turns of both
 * runs, and that the report of the source run cannot end the new run.
 */
export async function stepResume(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: `Read baseline.txt. ${REPORT_INSTRUCTION}`,
		cwd: state.repo,
		label: "codex-smoke-resume",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId) {
		report(state, "fail", STEP_NAMES.resume, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	const sourceId = ids.workerId;
	state.workersToCancel.push(sourceId);
	const sourceIdentity = identityOf(state.stateDir, sourceId);
	recordPanes(state, ids.paneId, sourceIdentity);
	recordThread(state, sourceIdentity.threadId);

	/* The step waits for the report of the source run. The report file
	   holds it, so the step does not depend on the text of the status. */
	const sourceSessionDir = join(state.stateDir, "sessions", sourceId);
	const reportDeadline = Date.now() + 300_000;
	let sourceReported = false;
	while (Date.now() < reportDeadline) {
		if (completedReportCount(sourceSessionDir, sourceId) > 0) {
			sourceReported = true;
			break;
		}
		await delay(2000);
	}
	if (!sourceReported) {
		report(
			state,
			"fail",
			STEP_NAMES.resume,
			`the source worker sent no report in ${Math.round(300_000 / 1000)} seconds`,
		);
		return;
	}

	/* The resume starts a second writer for the thread of the source run.
	   The panes of the source run must be gone first. The extension closes
	   them when the worker ends, so the step waits for them. */
	const sourcePanes = [sourceIdentity.tuiPaneId, sourceIdentity.serverPaneId].filter(
		(id): id is number => id !== null,
	);
	const paneDeadline = Date.now() + 60_000;
	while (Date.now() < paneDeadline) {
		const open = await currentPanes();
		if (sourcePanes.every((pane) => !open.includes(pane))) break;
		await delay(1000);
	}

	const resumed = await state.host.call("wezterm_worker_resume", {
		workerId: sourceId,
		message:
			"Reply with the word RESUME-OK. Then find the tool wezterm_worker_report with ALL_TOOLS, " +
			"call it, and report the state completed with the result RESUME-OK.",
		placement: "tab",
	});
	const resumeText = textOf(resumed);
	const resumedIds = spawnIds(resumed);
	if (!resumedIds.workerId) {
		report(
			state,
			"fail",
			STEP_NAMES.resume,
			`the resume returned no worker id: ${resumeText.replace(/\n/g, " | ")}`,
		);
		return;
	}
	state.workersToCancel.push(resumedIds.workerId);
	const resumedIdentity = identityOf(state.stateDir, resumedIds.workerId);
	recordPanes(state, resumedIds.paneId, resumedIdentity);
	recordThread(state, resumedIdentity.threadId);

	const parts: string[] = [];
	let failed = false;

	if (resumedIdentity.threadId === null || sourceIdentity.threadId === null) {
		parts.push("a thread of the two runs is unknown");
		failed = true;
	} else if (resumedIdentity.threadId !== sourceIdentity.threadId) {
		parts.push(
			`the resumed worker holds the thread ${resumedIdentity.threadId}, not the thread ${sourceIdentity.threadId}`,
		);
		failed = true;
	} else {
		parts.push(`the resumed worker keeps the thread ${resumedIdentity.threadId}`);
	}

	const resumedDone = await waitForStatusText(state, resumedIds.workerId, "RESUME-OK");
	if (!resumedDone.found) {
		parts.push(`the resumed worker reported no RESUME-OK: ${resumedDone.text.replace(/\n/g, " | ")}`);
		failed = true;
	} else {
		parts.push("a new report reached the owner");
	}

	const sourceStatus = await statusText(state, sourceId);
	const sourceLines = sourceStatus
		.split("\n")
		.filter((line) => line.startsWith(`${sourceId}  `) || line.includes(`result`))
		.join(" ");
	const sourceEnded = sourceLines.includes("COMPLETED");

	const turns = resumedIdentity.threadId === null ? 0 : rolloutTurnCount(resumedIdentity.threadId);
	if (turns < 2) {
		parts.push(`the thread holds ${turns} turn(s), not the turns of both runs`);
		failed = true;
	} else {
		parts.push(`the thread holds ${turns} turns`);
	}

	if (!sourceEnded) {
		parts.push("the source run did not end with its own report");
		failed = true;
	} else {
		parts.push("the report of the source run ended the source run and not the new run");
	}

	report(state, failed ? "fail" : "pass", STEP_NAMES.resume, parts.join("; "));
	/* The step ends the workers that it started. The source worker already
	   ended, so the cancel of it is harmless. */
	await cancelWorker(state, sourceId);
	await cancelWorker(state, resumedIds.workerId);
}

/** Wait until the status of a worker shows a text. */
async function waitForStatusText(
	state: SmokeState,
	workerId: string,
	needle: string,
	timeoutMs = 240_000,
): Promise<{ text: string; found: boolean }> {
	const deadline = Date.now() + timeoutMs;
	let text = await statusText(state, workerId);
	while (Date.now() < deadline) {
		if (text.includes(needle)) return { text, found: true };
		await delay(2000);
		text = await statusText(state, workerId);
	}
	return { text, found: text.includes(needle) };
}

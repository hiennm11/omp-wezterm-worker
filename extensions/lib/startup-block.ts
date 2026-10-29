/**
 * The startup block of a native worker.
 *
 * A Claude Code worker in a new repository waits at the trust dialog of
 * Claude Code. The session does not start while the dialog is open, so the
 * missing session start is the fact. The pane text only names the cause.
 *
 * The decision is a pure function of the state, the clock and the pane text.
 * A test can check it without a pane.
 */

import type { ClaudeRunState } from "./claude-run-state.ts";
import type { LifecycleDb } from "./db.ts";
import { createEvent, eventKey, findEventByKey, resolveObsoleteEvent } from "./events.ts";
import type { Job } from "./job.ts";
import { paneTail } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * How long a native worker may take to start its session.
 *
 * A worker that starts later than this, and that shows the trust dialog,
 * waits for the person.
 */
export const STARTUP_BLOCK_MS = 60_000;

/** The condition that a startup block raises. */
export const STARTUP_CONDITION = "startup_blocked";

/** The evidence id of the startup block. The run has one startup. */
const STARTUP_EVIDENCE_ID = "startup";

/** The words that the trust dialog of Claude Code shows. */
const TRUST_WORDS = "trust this folder";

/** The number of pane lines that the check reads. */
const PANE_LINES = 200;

/** The reason that a native worker waits at its start. */
export type StartupBlockReason = "trust_dialog";

/**
 * The reason that a native worker waits at its start, or null.
 *
 * The function returns a reason only when the three facts hold:
 *
 * - the session did not start, so `sessionId` is null;
 * - the launch is at least `STARTUP_BLOCK_MS` old;
 * - the pane text holds the words of the trust dialog.
 *
 * The pane text names the cause. It never proves that the worker waits.
 */
export function startupBlockReason(
	sessionId: string | null,
	launchedAt: number,
	now: number,
	paneText: string,
): StartupBlockReason | null {
	if (sessionId !== null) return null;
	if (now - launchedAt < STARTUP_BLOCK_MS) return null;
	if (!paneText.toLowerCase().includes(TRUST_WORDS)) return null;
	return "trust_dialog";
}

/**
 * Raise the event of a startup block.
 *
 * The key of the event joins the run, the startup and the condition. The
 * function creates the event once, so a repeated poll raises no second one.
 */
export function recordStartupBlock(
	db: LifecycleDb,
	runId: string,
	reason: StartupBlockReason,
	now: number,
): void {
	createEvent(
		db,
		`ev-${runId}-${STARTUP_EVIDENCE_ID}-${STARTUP_CONDITION}`,
		eventKey(runId, STARTUP_EVIDENCE_ID, STARTUP_CONDITION),
		runId,
		STARTUP_CONDITION,
		STARTUP_CONDITION,
		JSON.stringify({ reason }),
		true,
		now,
	);
}

/**
 * Resolve the event of a startup block.
 *
 * A session that started makes the event obsolete. The history of the event
 * stays. A run without the event writes nothing.
 */
export function resolveStartupBlock(db: LifecycleDb, runId: string, now: number): void {
	const key = eventKey(runId, STARTUP_EVIDENCE_ID, STARTUP_CONDITION);
	if (!findEventByKey(db, key)) return;
	resolveObsoleteEvent(
		db,
		runId,
		STARTUP_EVIDENCE_ID,
		STARTUP_CONDITION,
		"The session of the worker started.",
		now,
	);
}

/**
 * Check the start of a native run.
 *
 * The check reads the pane only while the session did not start. A run that
 * started never reads the pane, because the trust dialog cannot be there.
 * A failed read leaves the run without an event, and the next poll retries.
 */
export async function checkStartupBlock(
	rt: WorkerRuntime,
	job: Job,
	state: ClaudeRunState,
	now: number,
): Promise<void> {
	try {
		const db = rt.openDb();
		if (state.sessionId !== null) {
			resolveStartupBlock(db, job.id, now);
			return;
		}
		const launchedAt = job.startedAt ?? job.createdAt;
		if (now - launchedAt < STARTUP_BLOCK_MS) return;
		if (job.paneId === null) return;
		const reason = startupBlockReason(state.sessionId, launchedAt, now, await readPaneText(rt, job.paneId));
		if (reason === null) return;
		recordStartupBlock(db, job.id, reason, now);
	} catch (e) {
		/* a failed check must never end the monitor */
		rt.errors.push(e instanceof Error ? e.message : String(e));
	}
}

/**
 * The text of the pane of a worker.
 *
 * A pane that cannot be read gives an empty text. The empty text names no
 * cause, so the run raises no event.
 */
async function readPaneText(rt: WorkerRuntime, paneId: number): Promise<string> {
	try {
		return await paneTail(rt, paneId, PANE_LINES);
	} catch {
		return "";
	}
}

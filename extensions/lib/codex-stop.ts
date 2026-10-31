/**
 * The stop of a Codex worker.
 *
 * A Codex worker owns an app server and a TUI. A stop ends the open turn
 * through the protocol, ends the program of the app server and closes both
 * panes. The decision to interrupt a turn is a pure function of the run
 * state, so a test can call it without a pane.
 */

import type { ClaudeRunState } from "./claude-run-state.ts";
import type { CodexClient } from "./codex-client.ts";
import { endCodexProcesses } from "./codex-process.ts";
import type { Job } from "./job.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The request that ends the open turn of a thread. */
const INTERRUPT_METHOD = "turn/interrupt";

/**
 * The turn that a run still owes.
 *
 * The open turn is the cycle of the run that no completed turn closes. The
 * function returns null when no turn runs, so a stop sends no interrupt.
 */
export function openTurnId(state: ClaudeRunState | undefined): string | null {
	if (!state) return null;
	const cycle = state.currentCycleId;
	if (cycle === null) return null;
	if (state.completedTurns.has(cycle)) return null;
	return cycle;
}

/**
 * End the open turn of a Codex worker.
 *
 * The function ignores a failure of the request. A stop must end the worker
 * even when the app server cannot end the turn.
 */
async function interruptTurn(
	client: CodexClient | undefined,
	state: ClaudeRunState | undefined,
	threadId: string,
): Promise<void> {
	const turnId = openTurnId(state);
	if (!client || !turnId || !threadId) return;
	try {
		await client.request(INTERRUPT_METHOD, { threadId, turnId });
	} catch {
		/* The stop continues without the end of the turn. */
	}
}

/**
 * Stop a Codex worker.
 *
 * The function ends the open turn, ends the program of the app server and
 * closes both panes. It returns the names of the steps that failed. A step
 * that is already done is not a failure.
 */
export async function stopCodexWorker(rt: WorkerRuntime, job: Job): Promise<string[]> {
	await interruptTurn(rt.codexClients.get(job.id), rt.claudeStates.get(job.id), job.codex?.threadId ?? "");
	return endCodexProcesses(rt, job.codex ?? null);
}

/**
 * The reason of a stop that failed, or null when every step succeeded.
 *
 * The function joins the names of the failed steps. A stop without a failed
 * step is confirmed.
 */
export function codexStopFailure(failed: string[]): string | null {
	return failed.length === 0 ? null : failed.join("; ");
}

/**
 * Close the client of the app server of a run.
 *
 * The client holds a socket to the app server. A run that ends closes the
 * socket, so no run keeps a connection open.
 */
export function closeCodexClient(rt: WorkerRuntime, job: Job): void {
	const client = rt.codexClients.get(job.id);
	if (!client) return;
	rt.codexClients.delete(job.id);
	client.close();
}

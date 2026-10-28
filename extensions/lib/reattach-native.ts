/**
 * The re-attachment of a native worker after a restart.
 *
 * A restart loses the memory of a native run. The new owner must give the
 * worker a bridge again. The worker finds the new bridge through the handover
 * file of its session directory, and it follows it on its next poll.
 *
 * The worker sends a run snapshot to the new owner. The snapshot names the
 * cycle of the run, the instruction that waits, the calls that run and the
 * permission requests that wait.
 *
 * The new owner keeps the rows of the run. An open row blocks the completion
 * of the run until a settlement arrives, so the state of the run names the
 * calls that still run.
 *
 * The counts of the usage start at the restart. The usage of a restored run
 * is partial, because the turns before the restart stay unmeasured.
 */

import { writeHandover } from "./bridge-handover.ts";
import { startBridge } from "./claude-bridge.ts";
import { createClaudeRunState } from "./claude-run-state.ts";
import { outstandingExecutions } from "./executions.ts";
import type { Job } from "./job.ts";
import { observeNative } from "./native-ledger.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Give a native worker a bridge, a run state and a handover again.
 *
 * The function throws when the bridge cannot start or when the handover file
 * cannot be written. It then leaves the runtime without an entry for the run,
 * so the caller can fail the worker.
 */
export async function reattachNative(rt: WorkerRuntime, job: Job): Promise<void> {
	const state = createClaudeRunState(job.id);
	state.sessionId = job.nativeSessionId ?? null;
	state.usage.restoredAt = Date.now();

	/* The rows of the run survive the restart. An open row names a call that
	   still runs, so the new state must hold it as an open call. A row that
	   never settled stays unknown, and the owner resolves it. */
	for (const row of outstandingExecutions(rt.openDb(), job.id)) {
		if (row.state !== "open") continue;
		if (row.callId === null || row.toolName === null) continue;
		state.openCalls.set(row.callId, row.toolName);
	}

	const bridge = await startBridge(job.id, (observation) => {
		observeNative(rt, state, job.id, observation);
	});
	rt.claudeStates.set(job.id, state);
	rt.bridges.set(job.id, bridge);
	try {
		/* The worker reads the handover file on every poll. A new owner
		   writes it again, so the worker follows the new bridge. */
		writeHandover(job.sessionDir, { url: bridge.baseUrl, token: bridge.token });
	} catch (error) {
		rt.bridges.delete(job.id);
		rt.claudeStates.delete(job.id);
		await bridge.close();
		throw error;
	}
}

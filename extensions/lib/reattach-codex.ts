/**
 * The re-attachment of a Codex worker after a restart.
 *
 * A restart loses the memory of a Codex run. The new owner finds the app
 * server through the identity of the job, proves that the process is the
 * same `codex.exe`, and connects to that app server again. The worker then
 * reports to the new owner, and the owner can steer it and stop it.
 *
 * The proof of the process is a decision of three checks. A process with the
 * id of the identity must exist, its name must be `codex.exe`, and its
 * command line must hold the app server of the port of the identity. A
 * failed check means that the worker is not attached, so the owner stops it.
 *
 * The decision is a pure function of the process rows and the identity, so a
 * test can check it without a pane.
 */

import { writeHandover } from "./bridge-handover.ts";
import { startBridge } from "./claude-bridge.ts";
import { applyObservation, type ClaudeRunState } from "./claude-run-state.ts";
import type { CodexClient } from "./codex-client.ts";
import { connectCodexServer } from "./codex-client.ts";
import {
	type CodexProcessRow,
	isCodexServerProcess,
	mayEndCodexProcess,
	readProcessRows,
} from "./codex-process.ts";
import { attachCodexEvents } from "./codex-session.ts";
import { resumeThread } from "./codex-thread.ts";
import type { CodexIdentity, Job } from "./job.ts";
import { observeNative } from "./native-ledger.ts";
import { restoreRunState } from "./reattach-native.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The check of the identity that failed. */
export type CodexIdentityCheck = "process" | "name" | "command";

/** The verdict of the identity of an app server. */
export type CodexIdentityVerdict =
	| { ok: true; check: null; reason: null }
	| { ok: false; check: CodexIdentityCheck; reason: string };

/** The seams of one re-attachment. A test replaces them. */
export interface CodexReattachDeps {
	/** Connect to one app server. */
	connect?: (endpoint: string) => Promise<CodexClient>;
}

/**
 * The states of a turn that ended.
 *
 * The app server names the states of a turn. A turn with another state still
 * runs, so the state of the run holds it as an open turn.
 */
const FINISHED_TURNS = new Set(["completed", "failed", "interrupted"]);

/**
 * Decide whether the process of the table is the app server of the identity.
 *
 * The three checks are the process, the name and the command line. The
 * function reads no state of the machine, so a test can call it with the
 * rows of a table.
 */
export function codexIdentityVerdict(rows: CodexProcessRow[], identity: CodexIdentity): CodexIdentityVerdict {
	const pid = identity.serverPid;
	if (pid === null) {
		return {
			ok: false,
			check: "process",
			reason: "The check of the process failed: the identity of the worker holds no process id.",
		};
	}
	const row = rows.find((entry) => entry.processId === pid);
	if (!row) {
		return {
			ok: false,
			check: "process",
			reason: `The check of the process failed: the process ${pid} of the app server is gone.`,
		};
	}
	if (!mayEndCodexProcess(row.name)) {
		return {
			ok: false,
			check: "name",
			reason: `The check of the name failed: the process ${pid} runs ${row.name} and not codex.exe.`,
		};
	}
	if (!isCodexServerProcess(row, identity.port)) {
		return {
			ok: false,
			check: "command",
			reason:
				`The check of the command line failed: the process ${pid} does not run ` +
				`the app server of the port ${identity.port}.`,
		};
	}
	return { ok: true, check: null, reason: null };
}

/**
 * Give a Codex worker a client, a run state and a handover again.
 *
 * The function throws when the identity fails, when the app server does not
 * answer, or when the handover file cannot be written. It then leaves the
 * runtime without an entry for the run, so the caller can fail the worker.
 */
export async function reattachCodex(
	rt: WorkerRuntime,
	job: Job,
	deps: CodexReattachDeps = {},
): Promise<void> {
	const identity = job.codex ?? null;
	if (identity === null) {
		throw new Error("The check of the identity failed: the worker holds no Codex identity.");
	}
	const rows = await readProcessRows(rt, identity.serverPid);
	const verdict = codexIdentityVerdict(rows, identity);
	if (!verdict.ok) {
		/* The stop of a worker must never end a program that the check did
		   not prove. The identity loses its process id before the stop. */
		job.codex = { ...identity, serverPid: null };
		throw new Error(verdict.reason);
	}

	const state = restoreRunState(rt, job);
	const bridge = await startBridge(job.id, (observation) => {
		observeNative(rt, state, job.id, observation);
	});
	rt.claudeStates.set(job.id, state);
	rt.bridges.set(job.id, bridge);
	let client: CodexClient | null = null;
	try {
		/* The report server of Codex reads the handover file on every post,
		   so a new owner takes the reports of the worker over. */
		writeHandover(job.sessionDir, { url: bridge.baseUrl, token: bridge.token });
		const connect = deps.connect ?? ((endpoint: string) => connectCodexServer(endpoint));
		client = await connect(`ws://127.0.0.1:${identity.port}`);
		/* The handler of the client is set before the thread resumes. An
		   event of the app server then reaches the state of the run, even
		   when it arrives during the resume. */
		attachCodexEvents(rt, job, client);
		const resumed = await resumeThread(client, identity.threadId);
		if (resumed.error) {
			throw new Error(`The check of the thread failed: the thread did not resume. ${resumed.error}`);
		}
		/* A turn that started before the restart sends no event to the new
		   client. The list of the turns names it, so the state of the run
		   knows the turn that the worker still owes. */
		await restoreOpenTurn(state, job, client, identity.threadId);
	} catch (error) {
		client?.close();
		rt.codexClients.delete(job.id);
		rt.bridges.delete(job.id);
		rt.claudeStates.delete(job.id);
		await bridge.close();
		throw error;
	}
}

/**
 * Give the run state the turn that the thread still runs.
 *
 * The list of the turns names every turn of the thread with its state. A
 * turn that ended stays out of the state, so the state holds only the turn
 * that the worker still owes.
 */
async function restoreOpenTurn(
	state: ClaudeRunState,
	job: Job,
	client: CodexClient,
	threadId: string,
): Promise<void> {
	const answer = await client.request("thread/turns/list", { threadId });
	if (answer.error) return;
	const turns =
		(answer.result as { data?: Array<{ id?: unknown; status?: unknown }> } | undefined)?.data ?? [];
	for (const turn of turns) {
		const turnId = typeof turn.id === "string" ? turn.id : null;
		if (turnId === null) continue;
		if (typeof turn.status === "string" && FINISHED_TURNS.has(turn.status)) continue;
		applyObservation(state, {
			backend: "codex",
			runId: job.id,
			sessionId: threadId,
			source: "turn.start",
			payload: { turnId },
		});
	}
}

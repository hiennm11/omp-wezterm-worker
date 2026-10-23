/**
 * The ownership of the tasks of this main session.
 *
 * A task belongs to the main session that started it. The session acquires
 * the task when it starts the worker and when it finds the worker again after
 * a restart. The acquisition gives every record the identity and the
 * generation of the owner (docs/adr/0009-recoverable-omp-supervision.md).
 */

import type { SessionView } from "./host.ts";
import { acquireOwnership, readOwnership } from "./ownership.ts";
import { readProcessStart } from "./process-table.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * The result of an acquisition.
 *
 * `no-identity`: the host gives the session no identity, so no owner exists.
 * `owned`: another session, or another live process of this session, owns the task.
 * `unknown`: the process table cannot confirm that the previous process exited.
 */
export type Acquisition =
	| { acquired: true; generation: number }
	| { acquired: false; kind: "no-identity" | "owned" | "unknown"; reason: string };

/** The key of the ownership row of a worker. */
export function taskKey(jobId: string): string {
	return `task-${jobId}`;
}

/** Read the identity of the calling session from the host. */
export function bindSession(rt: WorkerRuntime, view: SessionView | null | undefined): void {
	rt.sessionId = view?.getSessionId?.() ?? null;
}

/**
 * The generation under which this session holds a task, or null.
 *
 * A task that another session owns, or that was released, gives null.
 */
export function generationOf(rt: WorkerRuntime, jobId: string): number | null {
	if (!rt.sessionId) return null;
	const owner = readOwnership(rt.openDb(), taskKey(jobId)).owner;
	if (!owner || owner.sessionId !== rt.sessionId || owner.phase === "released") return null;
	return owner.generation;
}

/**
 * Whether the session may supervise a worker after the acquisition.
 *
 * A session without an identity supervises as it did before the ownership
 * existed. A session that lost the acquisition only reads the records: a
 * second supervisor would deliver every event twice.
 */
export function maySupervise(acquisition: Acquisition): boolean {
	return acquisition.acquired || acquisition.kind === "no-identity";
}

/**
 * Acquire the task of a worker for this session.
 *
 * Another session never takes the task. That needs an explicit takeover. The
 * same session takes the task again after a restart, but only when the
 * process of the previous owner is confirmed gone. If two live processes open
 * the same session, the first one keeps the authority. An unreadable process
 * table refuses the acquisition.
 */
export async function acquireTask(rt: WorkerRuntime, jobId: string): Promise<Acquisition> {
	const sessionId = rt.sessionId;
	if (!sessionId) {
		return {
			acquired: false,
			kind: "no-identity",
			reason: "The host gives this session no identity, so the task has no owner.",
		};
	}
	if (rt.processStartedAt === null) {
		const own = await readProcessStart(rt, rt.processId);
		rt.processStartedAt = own.ok ? own.startedAt : null;
	}
	const db = rt.openDb();
	const key = taskKey(jobId);

	const held = readOwnership(db, key).owner;
	if (held && held.phase !== "released") {
		if (held.sessionId !== sessionId) {
			return {
				acquired: false,
				kind: "owned",
				reason: `The task is owned by session ${held.sessionId}. Take over explicitly.`,
			};
		}
		const sameProcess = held.processId === rt.processId && held.processStartedAt === rt.processStartedAt;
		if (!sameProcess) {
			if (held.processId === null || held.processStartedAt === null) {
				return { acquired: false, kind: "unknown", reason: "The previous owner process is not recorded." };
			}
			const probe = await readProcessStart(rt, held.processId);
			if (!probe.ok) {
				return {
					acquired: false,
					kind: "unknown",
					reason: `The process table cannot confirm that process ${held.processId} exited. The task stays with it.`,
				};
			}
			/* The start time tells a reused process id from the previous owner. */
			if (probe.startedAt === held.processStartedAt) {
				return {
					acquired: false,
					kind: "owned",
					reason: `Process ${held.processId} still owns the task. This process only reads it.`,
				};
			}
		}
	}

	const result = acquireOwnership(db, key, sessionId, rt.processId, rt.processStartedAt, Date.now());
	if (!result.acquired) return { acquired: false, kind: "owned", reason: result.reason };
	return { acquired: true, generation: result.owner.generation };
}

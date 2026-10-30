/**
 * wezterm_worker_takeover
 *
 * A main session takes the supervision of a worker that another session
 * owned. The previous owner must have released the task, or its process must
 * be confirmed gone. A live owner keeps the task.
 *
 * A session can also take back a task that it released itself. That task has
 * no other owner that could close the worker.
 */

import { attachWorker } from "../lib/attach.ts";
import { isActive } from "../lib/job.ts";
import { ensureOwnProcessStart, previousOwnerState, taskKey } from "../lib/owner.ts";
import { readOwnership, takeOverOwnership } from "../lib/ownership.ts";
import { findLiveWorkers } from "../lib/process-table.ts";
import { reconcileAttempts } from "../lib/recovery.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

/** The reason a takeover was refused. */
type RefusalReason =
	| "no-owner"
	| "no-identity"
	| "own"
	| "no-process-record"
	| "process-alive"
	| "process-unknown"
	| "own-process-unknown"
	| "changed";

/** The reply of a refused takeover. */
function refuse(workerId: string, reason: RefusalReason, text: string) {
	return reply(text, { workerId, taken: false, reason }, true);
}

export function registerTakeoverTool({ pi, rt, deliver }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_takeover",
		label: "Take Over Worker Supervision",
		description:
			"Take the supervision of a worker that another session owned. " +
			"The takeover needs a released task or a confirmed dead owner process. " +
			"A live owner keeps the task. A session can take back a task that it released itself. " +
			"The takeover does not replay pending events.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to take over."),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			const held = readOwnership(rt.openDb(), taskKey(job.id)).owner;
			if (!held) {
				return refuse(job.id, "no-owner", `Worker ${job.id} has no owner. A takeover is not needed.`);
			}
			const sessionId = rt.sessionId;
			if (sessionId === null) {
				return refuse(
					job.id,
					"no-identity",
					`This session has no identity, so it cannot take over worker ${job.id}.`,
				);
			}
			// A session that released a task can take it back. Without this
			// path the task has no owner that can close the worker.
			if (held.sessionId === sessionId && held.phase !== "released") {
				return refuse(job.id, "own", `This session already owns worker ${job.id}.`);
			}
			if (held.phase !== "released") {
				const previous = await previousOwnerState(rt, held);
				if (previous.state === "unknown") {
					const reason: RefusalReason =
						held.processId === null || held.processStartedAt === null
							? "no-process-record"
							: "process-unknown";
					return refuse(job.id, reason, previous.reason);
				}
				if (previous.state === "alive") {
					return refuse(job.id, "process-alive", previous.reason);
				}
			}
			// The new row needs the start time of this process. A row without
			// it names no owner, so no session can take the task over later.
			await ensureOwnProcessStart(rt);
			if (rt.processStartedAt === null) {
				return refuse(
					job.id,
					"own-process-unknown",
					`The process table cannot give the start time of this process, so the takeover would leave worker ${job.id} without a process record. Try again.`,
				);
			}
			const written = takeOverOwnership(
				rt.openDb(),
				taskKey(job.id),
				sessionId,
				rt.processId,
				rt.processStartedAt,
				held.generation,
				Date.now(),
			);
			if (!written.ok) {
				return refuse(job.id, "changed", written.reason);
			}
			// The new owner settles the open attempts of the task that it
			// took. An unreadable process table gives no worker, so the
			// attempt stays unresolved and raises an event for the owner.
			const workers = await findLiveWorkers(rt);
			reconcileAttempts(rt.openDb(), workers, sessionId, Date.now(), job.id);
			// A finished worker needs no monitor. The new owner holds the
			// authority for its pending events, but the worker stays as it is.
			if (!isActive(job)) {
				return reply(
					`This session now owns worker ${job.id} (generation ${written.generation}). ` +
						`The worker is already ${job.status}, so the session starts no monitor. ` +
						"Pending events are not replayed. Read them with wezterm_worker_status.",
					{ workerId: job.id, taken: true, generation: written.generation },
				);
			}
			// The session now owns the worker, so it must watch it.
			await attachWorker(rt, job, deliver);
			return reply(
				`This session now supervises worker ${job.id} (generation ${written.generation}). ` +
					"Pending events are not replayed. Read them with wezterm_worker_status.",
				{ workerId: job.id, taken: true, generation: written.generation },
			);
		},
	});
}

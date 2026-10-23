/**
 * wezterm_worker_takeover
 *
 * A main session takes the supervision of a worker that another session
 * owned. The previous owner must have released the task, or its process must
 * be confirmed gone. A live owner keeps the task.
 */

import { attachWorker } from "../lib/attach.ts";
import { readBackend } from "../lib/backend.ts";
import { isActive } from "../lib/job.ts";
import { previousOwnerState, taskKey } from "../lib/owner.ts";
import { readOwnership, takeOverOwnership } from "../lib/ownership.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

/** The reason a takeover was refused. */
type RefusalReason =
	| "no-owner"
	| "no-identity"
	| "own"
	| "native"
	| "no-process-record"
	| "process-alive"
	| "process-unknown"
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
			"A live owner keeps the task. The takeover does not replay pending events.",
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
			if (held.sessionId === sessionId) {
				return refuse(job.id, "own", `This session already owns worker ${job.id}.`);
			}
			// A native worker has no transcript, so the monitor cannot read it.
			if (readBackend(job) !== "omp") {
				return refuse(
					job.id,
					"native",
					`Worker ${job.id} is a native worker. The supervisor cannot attach it yet (issue 29).`,
				);
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

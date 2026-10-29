/**
 * wezterm_worker_release
 *
 * The owner stops the supervision of a task and gives the authority away.
 * The worker keeps running. The release waits for the external actions that
 * already started before the authority moves.
 */

import { clearHandover } from "../lib/bridge-handover.ts";
import { generationOf, taskKey } from "../lib/owner.ts";
import { beginRelease, commitRelease } from "../lib/ownership.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

export function registerReleaseTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_release",
		label: "Release Worker Supervision",
		description:
			"Stop the supervision of a worker and release the authority without stopping the worker. " +
			"The worker keeps running. A later main session can take the task over. " +
			"The release waits for the actions that already started.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to stop supervising."),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			const key = taskKey(job.id);
			const db = rt.openDb();
			const generation = generationOf(rt, job.id);
			if (rt.sessionId === null || generation === null) {
				return reply(
					`This session does not own worker ${job.id}, so it cannot release it.`,
					{ workerId: job.id, released: false },
					true,
				);
			}

			// The row of the run holds the state that the next owner reads. The
			// write needs the authority, so it runs before the phase moves.
			rt.persist();

			// The phase moves to releasing first. Every external action that
			// starts after this point is refused by the authority check.
			const begin = beginRelease(db, key, rt.sessionId, generation, Date.now());
			if (!begin.ok) {
				return reply(
					`The release of worker ${job.id} failed: ${begin.reason}`,
					{ workerId: job.id, released: false },
					true,
				);
			}

			// The release waits for the actions that already started.
			const unsettled = [...rt.pendingActions];
			if (unsettled.length > 0) {
				// The authority stays with the current owner. The phase stays
				// releasing, so the next release attempt sees the same state.
				return reply(
					"Worker " +
						job.id +
						" is still releasing. " +
						unsettled.length +
						" action(s) did not settle: " +
						unsettled.join(", ") +
						". The authority stays with this session.",
					{ workerId: job.id, released: false, unsettledActions: unsettled },
					true,
				);
			}

			const commit = commitRelease(db, key, rt.sessionId, generation, Date.now());
			if (!commit.ok) {
				return reply(
					`The release of worker ${job.id} failed: ${commit.reason}`,
					{ workerId: job.id, released: false },
					true,
				);
			}
			/* A released owner accepts no more commands for the worker. The
			   bridge of a native worker closes, and the handover file goes,
			   so the worker waits for its next owner. */
			const bridge = rt.bridges.get(job.id);
			if (bridge) {
				rt.bridges.delete(job.id);
				await bridge.close();
			}
			clearHandover(job.sessionDir);
			return reply(
				"The supervision of worker " +
					job.id +
					" stopped. The worker keeps running. " +
					"Another session can take the task over.",
				{ workerId: job.id, released: true },
			);
		},
	});
}

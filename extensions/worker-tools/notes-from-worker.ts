/**
 * wezterm_worker_notes_from_worker
 *
 * The main session reads the notes that a worker wrote for it. The read is
 * stateless. The caller passes the number of the last note that it read, and
 * the reply names the highest number of the channel.
 *
 * The tool checks the authority of the task, because a session that does not
 * hold the authority of a task only reads its records.
 */

import { controlRefusal, refusalDetails } from "../lib/authority.ts";
import { readBackend } from "../lib/backend.ts";
import { channelBackendRefusal, formatChannelNotes } from "../lib/channel-model.ts";
import { selectNotes } from "../lib/channel-select.ts";
import { readChannelNotes } from "../lib/channel-store.ts";
import type { ToolCtx } from "../lib/host.ts";
import { taskKey } from "../lib/owner.ts";
import { readOwnership } from "../lib/ownership.ts";
import { subagentControlRefusal } from "../lib/subagent.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

export function registerNotesFromWorkerTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_notes_from_worker",
		label: "Notes From WezTerm Worker",
		description:
			"Read the notes that a worker wrote for the main session. " +
			"The read is stateless. Pass the number of the last note that you read, or 0 for the first read.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker that wrote the notes."),
			afterSeq: z
				.number()
				.optional()
				.describe("The number of the last note that you read. The default is 0, which gives every note."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; afterSeq?: number },
			_signal: unknown,
			_onUpdate: unknown,
			ctx?: ToolCtx,
		) {
			const refusal = subagentControlRefusal(ctx);
			if (refusal) return reply(refusal, { refused: "subagent" }, true);
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
			const authorityRefusal = controlRefusal(owner, rt.sessionId, job.id);
			if (authorityRefusal) {
				return reply(authorityRefusal, refusalDetails(job.id, owner), true);
			}
			const backendRefusal = channelBackendRefusal(readBackend(job));
			if (backendRefusal) {
				return reply(backendRefusal, { workerId: job.id, notes: [], count: 0, refused: "backend" }, true);
			}
			const afterSeq = Number(params.afterSeq ?? 0);
			const all = readChannelNotes(job.sessionDir, "worker");
			const selection = selectNotes(all, afterSeq);
			return reply(formatChannelNotes(selection.notes, selection.highestSeq, `worker ${job.id}`), {
				workerId: job.id,
				notes: selection.notes,
				count: selection.notes.length,
				highestSeq: selection.highestSeq,
			});
		},
	});
}

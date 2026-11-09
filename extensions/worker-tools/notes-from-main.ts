/**
 * wezterm_worker_notes_from_main
 *
 * The worker reads the notes that the main session wrote for it. The read is
 * stateless. The caller passes the number of the last note that it read, and
 * the reply names the highest number of the channel.
 *
 * The tool is worker-only. A worker reads only its own channel.
 */

import { formatChannelNotes } from "../lib/channel-model.ts";
import { selectNotes } from "../lib/channel-select.ts";
import { readChannelNotes } from "../lib/channel-store.ts";
import type { ToolCtx } from "../lib/host.ts";
import { readRunContext } from "../lib/worker-context.ts";
import { reply, type ToolDeps } from "./kit.ts";
import { workerChannelRefusal, workerSessionDir } from "./worker-channel.ts";

export function registerNotesFromMainTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	rt.registerWorkerTool({
		name: "wezterm_worker_notes_from_main",
		label: "Notes From Main Session",
		description:
			"Read the notes that the main session wrote for you. " +
			"Call it at the start of each instruction cycle and before you report completed. " +
			"Pass the number of the last note that you read, or 0 for the first read.",
		parameters: z.object({
			afterSeq: z
				.number()
				.optional()
				.describe("The number of the last note that you read. The default is 0, which gives every note."),
		}),
		loadMode: "essential",
		async execute(
			_toolCallId: string,
			params: { afterSeq?: number },
			_signal?: unknown,
			_onUpdate?: unknown,
			_ctx?: ToolCtx,
		) {
			const sessionDir = workerSessionDir();
			if (!sessionDir) {
				return reply(
					"This process is not a worker. Only a worker reads the notes of the main session.",
					{ notes: [], count: 0 },
					true,
				);
			}
			const context = readRunContext(sessionDir);
			if (!context) {
				return reply(
					"The run context is missing. The worker was not launched by this extension.",
					{ notes: [], count: 0 },
					true,
				);
			}
			const refusal = workerChannelRefusal(context.backend);
			if (refusal) return reply(refusal, { notes: [], count: 0, refused: "backend" }, true);
			const afterSeq = Number(params.afterSeq ?? 0);
			const all = readChannelNotes(sessionDir, "main");
			const selection = selectNotes(all, afterSeq);
			return reply(formatChannelNotes(selection.notes, selection.highestSeq, "the main session"), {
				notes: selection.notes,
				count: selection.notes.length,
				highestSeq: selection.highestSeq,
				runId: context.runId,
			});
		},
	});
}

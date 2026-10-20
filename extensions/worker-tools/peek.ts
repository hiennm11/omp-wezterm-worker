/**
 * wezterm_worker_peek
 */

import { paneExists, paneTail } from "../lib/pane.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

const DEFAULT_LINES = 20;

export function registerPeekTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_peek",
		label: "Peek At WezTerm Worker Pane",
		description:
			"Show the last visible lines of a worker's pane. A debug aid for a worker that looks stuck. " +
			"The transcript remains the source of truth for the result; this only shows what is on screen.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to peek at."),
			lines: z.number().optional().describe(`How many lines to show. Default ${DEFAULT_LINES}.`),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string; lines?: number }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			if (job.paneId === null) {
				return reply(`Worker ${job.id} has no pane.`, { workerId: job.id }, true);
			}
			const text = await paneTail(rt, job.paneId, params.lines ?? DEFAULT_LINES);
			const details = { workerId: job.id, paneId: job.paneId, alive: await paneExists(rt, job.paneId) };
			return reply(text || "No pane text available. The pane may be closed.", details);
		},
	});
}

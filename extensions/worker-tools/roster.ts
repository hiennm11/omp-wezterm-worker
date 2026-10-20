/**
 * /wezterm-workers — the human-facing roster.
 */

import type { ToolDeps } from "./kit.ts";

export function registerRosterCommand({ pi, rt }: ToolDeps): void {
	pi.registerCommand("wezterm-workers", {
		description: "Show the WezTerm pane workers of this session.",
		handler: async (_args: string, ctx: { ui?: { notify?: (message: string, level?: string) => void } }) => {
			const jobs = [...rt.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
			if (jobs.length === 0) {
				ctx.ui?.notify?.("No WezTerm workers in this session.", "info");
				return;
			}
			const text = jobs.map((j) => `${j.id}  ${j.status}  pane=${j.paneId ?? "-"}  ${j.label}`).join("\n");
			ctx.ui?.notify?.(text, "info");
		},
	});
}

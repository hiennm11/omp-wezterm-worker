import { createHash } from "node:crypto";

import type { ReportTarget } from "./report-server.ts";

/** The name of the background execution tool. */
export const BACKGROUND_TOOL = "wezterm_worker_background";

/** The description of the background execution tool. */
export const BACKGROUND_TOOL_DESCRIPTION =
	"Declare a command that outlives this turn, then settle it after you see its result.";

/** The input schema of the background execution tool. */
export const BACKGROUND_TOOL_SCHEMA = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["declare", "settle"] },
		label: { type: "string" },
		status: { type: "string", enum: ["completed", "failed"] },
	},
	required: ["action", "label"],
};

/** The error that describes invalid background tool arguments. */
export function backgroundProblem(args: Record<string, unknown>): string | null {
	if (args.action !== "declare" && args.action !== "settle") return "action must be declare or settle";
	if (typeof args.label !== "string" || args.label.trim().length === 0) {
		return "label must be a non-empty string";
	}
	if (args.action === "settle" && args.status !== "completed" && args.status !== "failed") {
		return "status must be completed or failed";
	}
	return null;
}

/** Post one background execution observation to the bridge. */
export async function postBackground(
	target: ReportTarget,
	args: Record<string, unknown>,
): Promise<boolean> {
	const label = args.label as string;
	const callId = `codex-background-${createHash("sha256").update(label).digest("hex")}`;
	const declaring = args.action === "declare";
	try {
		const response = await fetch(`${target.url}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${target.token}`,
			},
			body: JSON.stringify({
				backend: "codex",
				runId: target.runId,
				source: declaring ? "tool.call.opened" : "background.settled",
				payload: {
					callId,
					tool: BACKGROUND_TOOL,
					background: true,
					...(declaring ? { label } : { status: args.status }),
				},
			}),
		});
		return response.ok;
	} catch {
		return false;
	}
}

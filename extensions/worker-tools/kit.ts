/**
 * What every tool module shares: its dependencies and its reply shape.
 */

import type { ExtensionAPI } from "../lib/host.ts";
import type { Job } from "../lib/job.ts";
import type { Refusal } from "../lib/limits.ts";
import type { WorkerRuntime } from "../lib/runtime.ts";

export interface ToolDeps {
	pi: ExtensionAPI;
	rt: WorkerRuntime;
	/** Put a finished worker's result into the main session. */
	deliver: (job: Job) => void;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

/** Build a tool reply. `isError` is left out of the reply when it is not given. */
export function reply(text: string, details: Record<string, unknown>, isError?: boolean): ToolResult {
	const result: ToolResult = { content: [{ type: "text", text }], details };
	if (isError !== undefined) result.isError = isError;
	return result;
}

/** The refusal reply for a launch that a limit blocks. */
export function refusalReply(refusal: Refusal): ToolResult {
	return reply(refusal.message, { refused: refusal.rule }, true);
}

/** The worker with this id, or the error reply that names the known ids. */
export function findJob(rt: WorkerRuntime, workerId: string): { job: Job } | { error: ToolResult } {
	const job = rt.jobs.get(workerId);
	if (job) return { job };
	return { error: reply(`Unknown worker id: ${workerId}`, { known: [...rt.jobs.keys()] }, true) };
}

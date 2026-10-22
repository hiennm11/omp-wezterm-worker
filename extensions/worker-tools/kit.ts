/**
 * What every tool module shares: its dependencies and its reply shape.
 */

import type { CommsResult, CommsSettings } from "../lib/comms-check.ts";
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

/** The details that a reply carries for the communication check. */
export function commsDetails(result: CommsResult): Record<string, unknown> {
	return {
		commsCheck: {
			channel: result.channel,
			score: result.score,
			verdict: result.verdict,
			findings: result.findings.map((finding) => ({
				rule: finding.rule,
				message: finding.message,
				line: finding.line,
			})),
		},
	};
}

/** The warning line that a low score adds to a reply. */
export function commsWarningLine(result: CommsResult, settings: CommsSettings): string {
	return `Communication check: the score is ${result.score}. The minimum score is ${settings.minScore}.`;
}

/** The refusal that a low score produces in the enforce mode. */
export function commsRefusalLine(result: CommsResult, settings: CommsSettings): string {
	const lines = result.findings.map((finding) => `- ${finding.message}`);
	const body = lines.length > 0 ? `\n${lines.join("\n")}` : "";
	return (
		`The communication check refused this text. The score is ${result.score}. ` +
		`The minimum score is ${settings.minScore}.${body}`
	);
}

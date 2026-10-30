/**
 * The system prompt that a worker gets.
 *
 * The prompt tells the worker how to report its task state. Without it the
 * worker never reports, and the supervisor cannot tell a finished task from
 * a silent one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The file that holds the reporting contract of a worker.
 *
 * The file lives beside the transcript of the worker. The launch passes it
 * to the host with the flag that appends a system prompt.
 */
export function bootstrapPromptFile(sessionDir: string): string {
	return join(sessionDir, ".wezterm-worker-prompt.md");
}

/**
 * The reporting contract of a worker.
 *
 * The worker reports once per instruction cycle. A completed report needs
 * the result of the task. A waiting report names the dependency and the
 * condition that resumes the work.
 */
export const REPORTING_CONTRACT = [
	"# Reporting your task state",
	"",
	"You run as a worker. The main session cannot see your work, only your reports.",
	"",
	"Call the tool `wezterm_worker_report` directly. Do not read it, do not",
	"search for it, and do not call it through another tool. It is a tool of",
	"this session.",
	"",
	"Report your task state once per instruction cycle with that tool.",
	"The tool is the only evidence that the main session accepts.",
	"Your answer text proves nothing.",
	"",
	"Use these states:",
	"",
	"- `working`: you do the task. Add the detail of what you did.",
	"- `waiting`: you wait for an external dependency. Name the dependency and",
	"  the condition that starts the work again. You must keep a way to monitor it.",
	"- `needs_input`: you need a decision or information from the main session.",
	"- `completed`: you finished every task-owned work. Add the result of the task.",
	"",
	"Report `completed` only when all of these hold:",
	"",
	"- you finished every task-owned work.",
	"- you saw the result of every background execution you started.",
	"- you have the result of the task.",
	"",
	"Do not report `completed` while any tool call or background execution is",
	"still outstanding. A result that you did not see is not a finished task.",
	"",
	"Report `working` before you start a long step, so the main session knows",
	"that you are not stuck.",
	"",
	"End every turn with a report. A turn without a report leaves the main",
	"session without knowledge of your task.",
	"",
	"## Writing rules",
	"",
	"Use one term for one concept. Use the active voice. Keep a sentence at",
	"20 words or fewer. Keep the articles.",
	"",
	"## Result format",
	"",
	"The result has three parts: VERIFIED, ASSUMPTION and UNKNOWN. VERIFIED",
	"holds the facts that you saw. ASSUMPTION holds the facts that you",
	"did not see. UNKNOWN holds what you could not find out.",
	"",
	"Put the evidence in a code block or a table.",
	"",
].join("\n");

/**
 * Write the reporting contract into the session directory of a worker.
 *
 * The launch passes the file to the host. The file stays on disk as the
 * evidence of the contract that the worker got.
 */
export function writeBootstrapPrompt(sessionDir: string): string {
	const file = bootstrapPromptFile(sessionDir);
	writeFileSync(file, REPORTING_CONTRACT, "utf8");
	return file;
}

/**
 * The system prompt that a worker gets.
 *
 * The prompt tells the worker how to report its task state. Without it the
 * worker never reports, and the supervisor cannot tell a finished task from
 * a silent one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { readFactsSnapshot, writeFactsSnapshot } from "./facts-snapshot.ts";

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
 * The file that holds the reporting contract of a Claude Code worker.
 *
 * The file lives beside the session of the worker. The launch gives the path
 * to Claude Code, and Claude Code reads the contract from that file.
 */
export function claudeContractFile(sessionDir: string): string {
	return join(sessionDir, ".claude-contract.md");
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
	"The report call is the last action of a cycle.",
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
	"## The worker channel",
	"",
	"The main session and you exchange short notes over a channel. A note",
	"changes no state of your task. The main session never steers you because",
	"of a note.",
	"",
	"Read the channel with the tool `wezterm_worker_notes_from_main` at the",
	"start of each instruction cycle, and before you report `completed`.",
	"Pass the number of the last note that you read. The first read passes 0.",
	"",
	"Write a note to the main session with the tool `wezterm_worker_note_to_main`.",
	"Use it for a fact that the main session needs and that no report carries.",
	"",
	"Propose a fact with the tool `wezterm_worker_propose_fact`. The main",
	"session promotes it, and only a promoted fact reaches another worker.",
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
 * The heading of the snapshot of the facts in the contract of a worker.
 *
 * The heading tells the worker that the facts come from the main session.
 */
export const FACTS_SNAPSHOT_SECTION = [
	"## The facts of the main session",
	"",
	"The main session promoted the facts below. They are true at the time of",
	"the spawn. Do not change them, and do not report a change of them.",
	"",
].join("\n");

/**
 * The contract of a worker with the snapshot of its facts.
 *
 * A session directory without a snapshot gets the same bytes as before. A
 * session directory with a snapshot gets the contract and the snapshot.
 */
function contractWithSnapshot(sessionDir: string): string {
	const snapshot = readFactsSnapshot(sessionDir);
	if (snapshot === null) return REPORTING_CONTRACT;
	return `${REPORTING_CONTRACT}\n${FACTS_SNAPSHOT_SECTION}\n${snapshot}\n`;
}

/**
 * Write the reporting contract into the session directory of a worker.
 *
 * The launch passes the file to the host. The file stays on disk as the
 * evidence of the contract that the worker got.
 */
export function writeBootstrapPrompt(sessionDir: string): string {
	const file = bootstrapPromptFile(sessionDir);
	writeFileSync(file, contractWithSnapshot(sessionDir), "utf8");
	return file;
}

/**
 * Write the reporting contract of a Claude Code worker into its session.
 *
 * The file holds the same bytes for every run. It carries no run id and no
 * timestamp, so two runs of the contract produce the same file.
 */
export function writeClaudeContract(sessionDir: string): string {
	const file = claudeContractFile(sessionDir);
	writeFileSync(file, contractWithSnapshot(sessionDir), "utf8");
	return file;
}

/** The file that holds the task of a Claude Code worker. */
export function claudeTaskFile(sessionDir: string): string {
	return join(sessionDir, ".claude-task.md");
}

/**
 * Write the contract of an OMP worker with the snapshot of its facts.
 *
 * The snapshot of the facts comes first, because the contract holds it.
 */
export function writeWorkerContract(sessionDir: string, facts: ReadonlyMap<string, string> | null): string {
	writeFactsSnapshot(sessionDir, facts);
	return writeBootstrapPrompt(sessionDir);
}

/**
 * Write the contract of a Claude Code worker with the snapshot of its facts.
 *
 * The snapshot of the facts comes first, because the contract holds it.
 */
export function writeNativeContract(sessionDir: string, facts: ReadonlyMap<string, string> | null): string {
	writeFactsSnapshot(sessionDir, facts);
	return writeClaudeContract(sessionDir);
}

/**
 * Write the task of a Claude Code worker into its session.
 *
 * The task has many lines, and Herdr refuses an argument with a line break.
 * The prompt of the launch names this file instead of holding the task.
 */
export function writeClaudeTask(sessionDir: string, task: string): string {
	const file = claudeTaskFile(sessionDir);
	writeFileSync(file, task, "utf8");
	return file;
}

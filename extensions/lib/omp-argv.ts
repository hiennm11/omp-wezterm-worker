/**
 * The command line of an OMP worker.
 *
 * Every value of the argv is its own element. The task and the follow-up
 * message are not in the argv of Herdr, because Herdr refuses an argument
 * with a line break. The launch sends them with the agent prompt.
 */

import { existsSync } from "node:fs";

import { bootstrapPromptFile } from "./bootstrap-prompt.ts";
import type { Job } from "./job.ts";
import { withWorkerTools } from "./preset.ts";

/**
 * The omp argv of a launch.
 *
 * The function reads no process and no pane. A test checks it without a
 * terminal.
 */
export function ompArgv(job: Job, resumeFile: string | null): string[] {
	const args = ["--no-title", "--cwd", job.cwd, "--session-dir", job.sessionDir];
	// The worker reports its task state. The prompt tells it how. Without the
	// prompt the worker never reports, and the supervisor cannot tell a
	// finished task from a silent one.
	const prompt = bootstrapPromptFile(job.sessionDir);
	if (existsSync(prompt)) args.push("--append-system-prompt", prompt);
	if (resumeFile) args.push("--resume", resumeFile);
	if (job.model) args.push("--model", job.model);
	const tools = withWorkerTools(job.tools);
	if (tools?.length) args.push("--tools", tools.join(","));
	// A job without a level asks for no level. OMP then runs the worker at
	// the default level of OMP.
	if (job.thinking) args.push("--thinking", job.thinking);
	return args;
}

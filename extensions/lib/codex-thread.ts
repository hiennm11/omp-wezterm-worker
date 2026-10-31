/**
 * The thread of a Codex worker.
 *
 * A new worker starts a thread. A resumed worker continues the thread of its
 * source run, so the worker comes back with its history.
 *
 * The order of the calls of a new thread is fixed. The request `thread/start`
 * alone writes no rollout file, and the TUI then ends at once. The request
 * `thread/name/set` writes that file, and the request `thread/resume` makes
 * the server load it.
 */

import { REPORTING_CONTRACT } from "./bootstrap-prompt.ts";
import { type CodexClient, threadIdOf } from "./codex-client.ts";
import type { Job } from "./job.ts";

/** The result of the preparation of the thread of a Codex worker. */
export interface CodexThreadResult {
	/** The reason that the preparation failed, or null when it succeeded. */
	error: string | null;
	/** The id of the thread. */
	threadId: string;
}

/**
 * Start the thread of a new Codex worker.
 *
 * The order of the calls is fixed. The request `thread/name/set` writes the
 * rollout file, and the request `thread/resume` makes the server load it.
 */
export async function startThread(client: CodexClient, job: Job): Promise<CodexThreadResult> {
	const started = await client.request("thread/start", threadStartParams(job));
	if (started.error) return { error: `the thread of Codex failed: ${started.error.message}`, threadId: "" };
	const threadId = threadIdOf(started);
	if (!threadId) return { error: "the thread of Codex holds no id.", threadId: "" };

	const named = await client.request("thread/name/set", { threadId, name: job.id });
	if (named.error) return { error: `the name of the thread failed: ${named.error.message}`, threadId: "" };

	const resumed = await client.request("thread/resume", { threadId });
	if (resumed.error)
		return { error: `the thread of Codex did not resume: ${resumed.error.message}`, threadId: "" };

	return { error: null, threadId };
}

/**
 * Continue the thread of a source run.
 *
 * A resume calls `thread/resume` with the thread id of the source run. The
 * rollout file of that thread already exists, so the resume needs no
 * `thread/name/set`.
 */
export async function resumeThread(client: CodexClient, threadId: string): Promise<CodexThreadResult> {
	const resumed = await client.request("thread/resume", { threadId });
	if (resumed.error)
		return { error: `the thread of Codex did not resume: ${resumed.error.message}`, threadId: "" };
	return { error: null, threadId };
}

/**
 * The parameters of the request `thread/start`.
 *
 * The model goes to the request only when the job names one. An omitted
 * model uses the default of Codex. The field `developerInstructions` carries
 * the reporting contract, so the worker knows how to report its task state.
 */
function threadStartParams(job: Job): Record<string, unknown> {
	const params: Record<string, unknown> = { cwd: job.cwd, developerInstructions: REPORTING_CONTRACT };
	if (job.model) params.model = job.model;
	return params;
}

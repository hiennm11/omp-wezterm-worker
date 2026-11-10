/**
 * The Codex backend was removed.
 *
 * A run that an older release wrote still holds the value `codex` in the
 * column `payload` of the table `runs`. The value stays there, so the run
 * never looks like a run of OMP. The schema of the database does not change.
 *
 * Every tool that would start, resume, steer or cancel such a run refuses it
 * with one sentence. See ADR 0026.
 */

import { isRemovedBackend } from "./backend.ts";
import type { JobStatus } from "./job.ts";

/** The sentence that every tool replies with for a run of the removed backend. */
export const REMOVED_BACKEND_REFUSAL =
	"This run used the Codex backend. The Codex backend was removed.";

/**
 * The refusal for a run of the removed backend, or null when the run is of a
 * backend that the extension still has.
 */
export function removedBackendRefusal(job: { backend?: unknown }): string | null {
	return isRemovedBackend(job) ? REMOVED_BACKEND_REFUSAL : null;
}

/**
 * The status of a run of the removed backend.
 *
 * The extension can no longer attach to such a run, so it never runs. A run
 * that was active is history, and the status is the status of an ended run.
 * A run that already ended keeps its status.
 */
export function removedRunStatus(job: { backend?: unknown; status: JobStatus }): JobStatus {
	if (!isRemovedBackend(job)) return job.status;
	if (job.status === "running" || job.status === "queued") return "cancelled";
	return job.status;
}

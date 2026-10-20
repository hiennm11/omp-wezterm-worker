/**
 * The launch limits.
 *
 * `launchRefusal` is a pure decision. `admitLaunch` applies it to the
 * runtime and reserves the job id in the same synchronous step.
 */

import type { WorkerConfig } from "./config.ts";
import { isActive, type Job } from "./job.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** A worker transcript lives in <stateDir>/sessions/<jobId>/<file>.jsonl. */
const WORKER_SESSION = /[\\/]sessions[\\/]wz-[0-9a-z]+-[0-9a-z]+[\\/][^\\/]+\.jsonl$/i;

/** True when this session file belongs to a worker that this extension started. */
export function isWorkerSession(sessionFile: string | null | undefined): boolean {
	return typeof sessionFile === "string" && WORKER_SESSION.test(sessionFile);
}

export type LimitRule = "nestedWorker" | "maxActiveWorkers" | "maxLaunchesPerRequest";

export interface Refusal {
	rule: LimitRule;
	message: string;
}

/** The reason a launch is refused now, or null when it is allowed. */
export function launchRefusal(
	jobs: ReadonlyMap<string, Job>,
	requestLaunches: readonly string[],
	config: Pick<WorkerConfig, "maxActiveWorkers" | "maxLaunchesPerRequest">,
	sessionFile: string | null | undefined,
): Refusal | null {
	if (isWorkerSession(sessionFile)) {
		return {
			rule: "nestedWorker",
			message: `This process is a worker (${sessionFile}). A worker cannot launch another worker. Report your result instead.`,
		};
	}

	const max = config.maxActiveWorkers;
	if (max > 0) {
		let active = 0;
		for (const job of jobs.values()) if (isActive(job)) active += 1;
		if (active >= max) {
			return {
				rule: "maxActiveWorkers",
				message: `${active} worker(s) are active. The limit is ${max} (maxActiveWorkers). Wait for a worker to finish, or cancel one, then try again.`,
			};
		}
	}

	const maxLaunches = config.maxLaunchesPerRequest;
	if (maxLaunches > 0) {
		// A launch that failed before its pane existed did not use a pane.
		const launched = requestLaunches.filter((id) => {
			const job = jobs.get(id);
			return !job || isActive(job) || job.startedAt !== null;
		}).length;
		if (launched >= maxLaunches) {
			return {
				rule: "maxLaunchesPerRequest",
				message: `This request already launched ${launched} worker(s). The limit is ${maxLaunches} (maxLaunchesPerRequest). The next user prompt resets the count.`,
			};
		}
	}
	return null;
}

/**
 * Check the limits and reserve a job id.
 *
 * Synchronous, so two parallel calls cannot both pass. The caller must not
 * `await` between this call and `spawnWorker` or `resumeWorker`, which put
 * the job into `rt.jobs` before their first `await`.
 */
export function admitLaunch(
	rt: WorkerRuntime,
	sessionFile: string | null | undefined,
): { jobId: string } | { refusal: Refusal } {
	const refusal = launchRefusal(rt.jobs, rt.requestLaunches, rt.config, sessionFile);
	if (refusal) return { refusal };
	const jobId = rt.nextJobId();
	rt.requestLaunches.push(jobId);
	return { jobId };
}

/** A user prompt starts a new request. */
export function startRequest(rt: WorkerRuntime): void {
	rt.requestLaunches = [];
}

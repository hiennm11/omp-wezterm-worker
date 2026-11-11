/**
 * The background jobs that a transcript names.
 *
 * OMP writes the end of a background job in several shapes. A follow-up
 * entry holds the jobs under the key `jobs` with the key `jobId`. The result
 * of the tool `wait` holds the jobs under the key `jobs` with the key `id`.
 * The result of a read or a kill of `proc://bg_N` holds them under the key
 * `proc`. The result of the call that started the job holds the job under
 * the key `async`. Every shape names the job and its status.
 */

/** One background job that the transcript reports as finished. */
export interface BackgroundResult {
	/** The id of the job. */
	jobId: string;
	/** The status of the job, for example `completed` or `failed`. */
	status: string;
}

/** The statuses of a background job that mean the job ended. */
export const SETTLED_JOB_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	cancelled: true,
};

/**
 * The finished background jobs that one entry names.
 *
 * The entry holds the jobs under the key `jobs` and the job id under the key
 * `jobId`. A job without a string id or without a string status is skipped.
 */
export function backgroundResultsOf(details: unknown): BackgroundResult[] {
	if (!details || typeof details !== "object") return [];
	const jobs = (details as Record<string, unknown>).jobs;
	if (!Array.isArray(jobs)) return [];
	const found: BackgroundResult[] = [];
	for (const job of jobs) {
		const result = resultOf(job, "jobId");
		if (result) found.push(result);
	}
	return found;
}

/**
 * The background jobs that the result of the tool wait names.
 *
 * The result of the tool wait holds the jobs under the key `id`. A result
 * that an incoming message interrupted names no job that ended. The function
 * skips such a result and every job without a string id or a string status.
 */
export function waitResultsOf(details: unknown): BackgroundResult[] {
	if (!details || typeof details !== "object") return [];
	const record = details as Record<string, unknown>;
	if (record.interrupted === true) return [];
	const jobs = record.jobs;
	if (!Array.isArray(jobs)) return [];
	const found: BackgroundResult[] = [];
	for (const job of jobs) {
		const result = resultOf(job, "id");
		if (result) found.push(result);
	}
	return found;
}

/**
 * The background jobs that the result of a read or a kill names.
 *
 * The result of a read holds one job under the key `job`. The result of a
 * kill holds the jobs under the key `jobs`. Both hold the id under the key
 * `id`. Only a job with a terminal status is reported, because a read of a
 * running job names no end.
 */
export function procResultsOf(details: unknown): BackgroundResult[] {
	if (!details || typeof details !== "object") return [];
	const proc = (details as Record<string, unknown>).proc;
	if (!proc || typeof proc !== "object") return [];
	const record = proc as Record<string, unknown>;
	const found: BackgroundResult[] = [];
	const single = resultOf(record.job, "id");
	if (single && Object.hasOwn(SETTLED_JOB_STATUSES, single.status)) found.push(single);
	const jobs = record.jobs;
	if (!Array.isArray(jobs)) return found;
	for (const job of jobs) {
		const result = resultOf(job, "id");
		if (result && Object.hasOwn(SETTLED_JOB_STATUSES, result.status)) found.push(result);
	}
	return found;
}

/**
 * The background job that the result of the call that started it names.
 *
 * The result holds the job under the key `async`. The key `state` holds its
 * status. Only a terminal status is reported, because a call that starts a
 * job names no end.
 */
export function callResultsOf(details: unknown): BackgroundResult[] {
	if (!details || typeof details !== "object") return [];
	const async = (details as Record<string, unknown>).async;
	if (!async || typeof async !== "object") return [];
	const record = async as Record<string, unknown>;
	const jobId = record.jobId;
	const status = record.state;
	if (typeof jobId !== "string" || typeof status !== "string") return [];
	if (!Object.hasOwn(SETTLED_JOB_STATUSES, status)) return [];
	return [{ jobId, status }];
}

/**
 * The job that one record names, or null when the record names no job.
 *
 * The record holds the job id under the given key and the status under the
 * key `status`. A record without a string id or without a string status
 * names no job.
 */
function resultOf(value: unknown, idKey: string): BackgroundResult | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const jobId = record[idKey];
	const status = record.status;
	if (typeof jobId !== "string" || typeof status !== "string") return null;
	return { jobId, status };
}

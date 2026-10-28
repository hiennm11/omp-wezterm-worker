/**
 * The replay of a result that the old owner never delivered.
 *
 * A restart can lose the result of a finished run. The run is then completed
 * or failed, and the table `deliveries` holds no row in the state `sent` for
 * it. The recovery sends that result again.
 *
 * A cancelled run has no delivery row by design. The cancel tool replies at
 * once, so the replay skips it.
 *
 * The old finished runs must not be sent. The mark `delivery_replay_since`
 * holds the time of the first recovery. Later recoveries send only the runs
 * that ended at or after that time.
 */

import { deliveriesOfEvent } from "./delivery.ts";
import type { Job } from "./job.ts";
import { generationOf } from "./owner.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The key of the mark that holds the time of the first recovery. */
const REPLAY_MARK = "delivery_replay_since";

/**
 * The runs whose result never reached the main session.
 *
 * A run that ended without a delivery in the state `sent` lost its result in
 * a restart. A cancelled run has no delivery by design, so it stays out.
 * A `since` of null sets no limit.
 */
export function runsToReplay(jobs: Job[], sent: Set<string>, since: number | null): Job[] {
	return jobs.filter((job) => {
		if (job.status !== "completed" && job.status !== "failed") return false;
		if (job.finishedAt === null) return false;
		if (sent.has(job.id)) return false;
		if (since !== null && job.finishedAt < since) return false;
		return true;
	});
}

/**
 * Send the result of the runs that this session owns and never delivered.
 *
 * A run of another session stays with its owner. A delivery that fails does
 * not stop the replay of the next run.
 */
export function replayUndelivered(
	rt: WorkerRuntime,
	jobs: Job[],
	notify: (job: Job) => void,
	since: number | null,
): Job[] {
	const db = rt.openDb();
	const owned = jobs.filter((job) => generationOf(rt, job.id) !== null);
	const sent = new Set<string>();
	for (const job of owned) {
		for (const attempt of deliveriesOfEvent(db, job.id)) {
			if (attempt.state === "sent") sent.add(attempt.eventId);
		}
	}
	const replayed: Job[] = [];
	for (const job of runsToReplay(owned, sent, since)) {
		try {
			notify(job);
			replayed.push(job);
		} catch (e) {
			rt.errors.push(`The replay of worker ${job.id} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return replayed;
}

/**
 * The recovery of the results that a restart lost.
 *
 * The first recovery writes the mark and replays no run that ended before
 * it. A later recovery uses the stored mark.
 */
export function recoverTask(
	rt: WorkerRuntime,
	jobs: Job[],
	notify: (job: Job) => void,
	now: number,
): Job[] {
	const db = rt.openDb();
	const mark = db.meta(REPLAY_MARK);
	let since: number;
	if (mark === null) {
		db.setMeta(REPLAY_MARK, String(now));
		since = now;
	} else {
		// A mark that is not a number must not send the old runs.
		const stored = Number(mark);
		since = Number.isFinite(stored) ? stored : now;
	}
	return replayUndelivered(rt, jobs, notify, since);
}

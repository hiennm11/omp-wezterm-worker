import { pendingEvents, recordHandling, type EventCondition, type WorkerEvent } from "./events.ts";
import { isActive, type Job } from "./job.ts";
import { generationOf } from "./owner.ts";
import type { WorkerRuntime } from "./runtime.ts";

const EXPIRABLE_CONDITIONS: Record<EventCondition, true> | Partial<Record<EventCondition, true>> = {
	missing_report: true,
	idle_after_working: true,
	execution_loss: true,
	thinking_stall: true,
	startup_blocked: true,
};

/** Return no-action events whose run and event both exceed the expiry limit. */
export function expirableEvents(events: WorkerEvent[], jobs: Job[], now: number, limitMs: number): WorkerEvent[] {
	if (limitMs <= 0) return [];
	const byId = new Map(jobs.map((job) => [job.id, job]));
	return events.filter((event) => {
		if (!EXPIRABLE_CONDITIONS[event.condition] || event.runId === null) return false;
		const job = byId.get(event.runId);
		if (!job || isActive(job)) return false;
		const endedAt = Math.max(event.createdAt, job.finishedAt ?? event.createdAt);
		return now - endedAt >= limitMs;
	});
}

/** Close old no-action events for the runs this session owns. */
export function expireStaleEvents(rt: WorkerRuntime, jobs: Job[], now: number): string[] {
	const ownedEvents = pendingEvents(rt.openDb()).filter((event) => event.runId !== null && generationOf(rt, event.runId) !== null);
	const expired: string[] = [];
	for (const event of expirableEvents(ownedEvents, jobs, now, rt.config.eventExpiryMs)) {
		const runId = event.runId;
		if (runId === null) continue;
		const generation = generationOf(rt, runId);
		if (generation === null) continue;
		const job = jobs.find((candidate) => candidate.id === runId);
		if (!job) continue;
		const endedAt = Math.max(event.createdAt, job.finishedAt ?? event.createdAt);
		const hours = Math.floor((now - endedAt) / (60 * 60 * 1000));
		const note = `The run ended ${hours} h ago. The event needed no action after that.`;
		const outcome = recordHandling(rt.openDb(), event.id, "expired", note, rt.sessionId, generation, now);
		if (outcome.ok && outcome.handling.disposition === "expired" && outcome.handling.createdAt === now) expired.push(event.id);
	}
	return expired;
}


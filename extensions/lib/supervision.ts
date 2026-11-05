import { isActive, type Job } from "./job.ts";
import type { Ownership } from "./ownership.ts";

/**
 * The answer of the host about the lease of a session.
 *
 * `true`: a process holds the lease. `false`: the lease is free. `null`: the
 * host cannot answer.
 */
export type LeaseAnswer = boolean | null;

/**
 * The name of a lease answer.
 *
 * The name tells the reader why the task stayed read-only. A held lease and
 * an unanswered probe keep the task with the first owner.
 */
export function leaseAnswerText(answer: LeaseAnswer): string {
	if (answer === true) return "true";
	if (answer === false) return "false";
	return "null";
}

/**
 * The supervision line of the status tool.
 *
 * A read-only row names the answer of the lease and the process that owns
 * the task, so the reader knows why the task stays read-only here.
 */
export function supervisionLine(
	job: Job,
	owner: Ownership | null,
	sessionId: string | null,
	processId: number,
	processStartedAt: string | null,
	monitored: boolean,
	lease: LeaseAnswer = null,
): string | null {
	if (!isActive(job) || !owner || owner.phase !== "active") return null;
	if (
		owner.sessionId === sessionId &&
		owner.processId === processId &&
		owner.processStartedAt === processStartedAt
	) {
		return monitored ? null : "NOT SUPERVISED: this process owns the task, but no monitor watches it.";
	}
	return (
		`read-only here: session ${owner.sessionId}, process ${owner.processId ?? "unknown"} owns this task; ` +
		`the owner can be alive or gone. The owner process may need to close, or OMP may need to restart. ` +
		`The lease of the session is ${leaseAnswerText(lease)}, the owner process is ${owner.processId ?? "unknown"}.`
	);
}

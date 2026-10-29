/**
 * The authority of a task.
 *
 * One main session holds the authority of a task. That session controls the
 * worker and delivers its events. A session that does not hold the authority
 * only reads the records of the task.
 *
 * The functions here are pure. They read no database and start no program.
 * The caller reads the ownership row and gives it to a rule.
 */

import type { Ownership } from "./ownership.ts";

/**
 * The reason that a control action must not go on, or null when it may go on.
 *
 * A control action steers a worker or cancels it. Only the owner of the task
 * may do it. A session without an identity owns nothing, so it may do it. A
 * task without an ownership row has no owner, so it may do it too.
 */
export function controlRefusal(
	owner: Ownership | null,
	sessionId: string | null,
	workerId: string,
): string | null {
	if (sessionId === null || owner === null) return null;
	if (owner.sessionId !== sessionId) {
		return (
			`Worker ${workerId} belongs to session ${owner.sessionId} (phase ${owner.phase}). ` +
			"This session only reads it."
		);
	}
	if (owner.phase === "released") {
		return `This session released worker ${workerId}. Take it back with wezterm_worker_takeover.`;
	}
	if (owner.phase === "releasing") return `This session is releasing worker ${workerId}.`;
	return null;
}

/**
 * The reason that a cleanup action must not go on, or null when it may go on.
 *
 * A cleanup action removes the resources of a task. Another session that
 * holds the task in the phase active or releasing keeps them. A released task
 * has no owner, so every session may clean it up.
 */
export function cleanupRefusal(
	owner: Ownership | null,
	sessionId: string | null,
	workerId: string,
): string | null {
	if (sessionId === null || owner === null) return null;
	if (owner.sessionId === sessionId) return null;
	if (owner.phase === "released") return null;
	return (
		`Worker ${workerId} belongs to session ${owner.sessionId} (phase ${owner.phase}). ` +
		"This session only reads it."
	);
}

/** The details that a refusal reply carries. */
export function refusalDetails(workerId: string, owner: Ownership | null): Record<string, unknown> {
	return { workerId, owner: owner?.sessionId ?? null, phase: owner?.phase ?? null };
}

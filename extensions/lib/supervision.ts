import { isActive, type Job } from "./job.ts";
import type { Ownership } from "./ownership.ts";

export function supervisionLine(
	job: Job,
	owner: Ownership | null,
	sessionId: string | null,
	processId: number,
	processStartedAt: string | null,
	monitored: boolean,
): string | null {
	if (!isActive(job) || !owner || owner.phase !== "active") return null;
	if (
		owner.sessionId === sessionId &&
		owner.processId === processId &&
		owner.processStartedAt === processStartedAt
	) {
		return monitored ? null : "NOT SUPERVISED: this process owns the task, but no monitor watches it.";
	}
	return `read-only here: session ${owner.sessionId}, process ${owner.processId ?? "unknown"} owns this task; the owner can be alive or gone. The owner process may need to close, or OMP may need to restart.`;
}

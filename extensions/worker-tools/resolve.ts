/**
 * wezterm_worker_resolve
 *
 * The owner settles an unknown task outcome. The resolution never creates an
 * explicit worker completion report. The evidence note says what the owner
 * actually confirmed.
 */

import { freeUnresolvedAttempt } from "../lib/attempts.ts";
import { readEvent, type WorkerEvent } from "../lib/events.ts";
import type { ToolCtx } from "../lib/host.ts";
import { generationOf } from "../lib/owner.ts";
import { type OwnerResolution, RESOLUTIONS, recordResolution } from "../lib/resolution.ts";
import { writeUnderAuthority } from "../lib/write-authority.ts";
import { reply, type ToolDeps } from "./kit.ts";

/**
 * The attempt that an unresolved launch event names.
 *
 * The payload of the event holds the id of the attempt row and the id of the
 * job. An event without a payload names no attempt.
 */
function attemptIdOf(event: WorkerEvent): string | null {
	if (event.condition !== "unresolved_launch") return null;
	if (!event.payload) return null;
	try {
		const parsed = JSON.parse(event.payload) as { attemptId?: unknown };
		return typeof parsed.attemptId === "string" ? parsed.attemptId : null;
	} catch {
		return null;
	}
}

/** The resolutions that the tool accepts. */
export function registerResolveTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_resolve",
		label: "Resolve Worker Outcome",
		description:
			"Resolve an unknown worker outcome. Use this for a legacy worker and for a launch that stayed uncertain. " +
			"The resolution records what you confirmed. It does not create a worker completion report, and it does not stop a running worker.",
		parameters: z.object({
			workerId: z.string().describe("The worker whose outcome is unknown."),
			eventId: z.string().describe("The event that describes the unknown outcome."),
			resolution: z
				.string()
				.describe(
					"The resolution. One of: " +
						RESOLUTIONS.join(", ") +
						". Use recorded_result for a saved result, incomplete for work that did not finish, abandoned for work that will not continue.",
				),
			evidenceNote: z.string().describe("What you actually confirmed. State the evidence that you saw."),
		}),
		loadMode: "essential",
		async execute(_toolCallId: string, params: Record<string, unknown>, _ctx?: ToolCtx) {
			const workerId = String(params.workerId ?? "");
			const eventId = String(params.eventId ?? "");
			const resolution = String(params.resolution ?? "") as OwnerResolution;
			const evidenceNote = String(params.evidenceNote ?? "");
			if (!workerId || !eventId || !evidenceNote) {
				return reply(
					"The worker id, the event id and the evidence note are all required.",
					{ resolved: false },
					true,
				);
			}
			if (!RESOLUTIONS.includes(resolution)) {
				return reply(`The resolution must be one of ${RESOLUTIONS.join(", ")}.`, { resolved: false }, true);
			}
			const db = rt.openDb();
			const event = readEvent(db, eventId);
			if (!event) {
				return reply(`Unknown event id: ${eventId}`, { resolved: false }, true);
			}
			if (!event.actionable) {
				return reply(`The event ${eventId} needs no action.`, { resolved: false }, true);
			}
			const attemptId = attemptIdOf(event);
			if (event.condition === "unresolved_launch" && resolution === "recorded_result") {
				return reply(
					`The event ${eventId} is an unresolved launch. The worker of that launch never reported a result. ` +
						"Use abandoned or incomplete to free the launch attempt.",
					{ resolved: false, eventId, attemptId },
					true,
				);
			}
			if (resolution === "recorded_result" && !event.payload) {
				return reply(
					"A recorded result needs a saved result. The event holds none.",
					{ resolved: false },
					true,
				);
			}
			/* The authority of the task of the event is checked in the same
			   transaction as the write. The event names its worker, so the
			   worker of the parameter cannot name another task. */
			const written = writeUnderAuthority(db, rt.sessionId, event.runId, () => {
				const outcome = recordResolution(
					db,
					`res-${eventId}`,
					eventId,
					event.runId,
					resolution,
					evidenceNote,
					rt.sessionId,
					generationOf(rt, workerId),
					Date.now(),
				);
				if (!outcome.ok) return outcome;
				/* The resolution of an unresolved launch frees the attempt.
				   The write and the release run in one transaction. */
				if (attemptId !== null) freeUnresolvedAttempt(db, attemptId, Date.now());
				return outcome;
			});
			if (written.refused) {
				return reply(written.refusal, { ...written.details, resolved: false }, true);
			}
			const outcome = written.value;
			if (!outcome.ok) {
				return reply(outcome.reason, { resolved: false }, true);
			}
			return reply(
				"The outcome of worker " +
					workerId +
					" is now " +
					resolution +
					". The transcript and the worktree stay.",
				{
					resolved: true,
					workerId,
					eventId,
					resolution,
					recordedAt: outcome.resolution.createdAt,
				},
			);
		},
	});
}

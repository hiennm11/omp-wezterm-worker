/**
 * wezterm_worker_ack
 *
 * The owner records that it handled a worker event. The acknowledgement is
 * separate from the delivery. A message that reached the main session is not
 * an acknowledgement.
 */

import { type Disposition, readEvent, recordHandling } from "../lib/events.ts";
import type { ToolCtx } from "../lib/host.ts";
import { reply, type ToolDeps } from "./kit.ts";

/** The dispositions that the tool accepts. */
const DISPOSITIONS: Disposition[] = ["accepted", "follow_up", "discarded"];

export function registerAckTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_ack",
		label: "Acknowledge Worker Event",
		description:
			"Record that you handled a worker event and choose a disposition. " +
			"Read the event first. A delivery does not prove that you handled it.",
		parameters: z.object({
			workerId: z.string().describe("The worker that the event belongs to."),
			eventId: z.string().describe("The event that you handled."),
			disposition: z
				.string()
				.describe(
					`The disposition. One of: ${DISPOSITIONS.join(", ")}. Use discarded only when the event no longer applies.`,
				),
			note: z.string().optional().describe("What you did with the event."),
		}),
		loadMode: "essential",
		async execute(_toolCallId: string, params: Record<string, unknown>, _ctx?: ToolCtx) {
			const workerId = String(params.workerId ?? "");
			const eventId = String(params.eventId ?? "");
			const disposition = String(params.disposition ?? "") as Disposition;
			const note = typeof params.note === "string" ? params.note : null;
			if (!workerId || !eventId) {
				return reply("The worker id and the event id are both required.", { acknowledged: false }, true);
			}
			if (!DISPOSITIONS.includes(disposition)) {
				return reply(
					`The disposition must be one of ${DISPOSITIONS.join(", ")}.`,
					{ acknowledged: false },
					true,
				);
			}
			const db = rt.openDb();
			const event = readEvent(db, eventId);
			if (!event) {
				return reply(`Unknown event id: ${eventId}`, { acknowledged: false }, true);
			}
			const outcome = recordHandling(
				db,
				eventId,
				disposition,
				note,
				rt.ownerId,
				rt.ownerGeneration,
				Date.now(),
			);
			if (!outcome.ok) {
				return reply(outcome.reason, { acknowledged: false }, true);
			}
			return reply(`The event ${eventId} is handled as ${disposition}.`, {
				acknowledged: true,
				workerId,
				eventId,
				disposition,
			});
		},
	});
}

/**
 * wezterm_worker_note_to_worker
 *
 * The main session writes a short note to a worker. The note changes no
 * state of the task, and the extension never steers the worker when a note
 * arrives.
 *
 * The tool checks the authority of the task, because a session that does not
 * hold the authority of a task only reads its records.
 */

import { controlRefusal, refusalDetails } from "../lib/authority.ts";
import { readBackend } from "../lib/backend.ts";
import { type ChannelNote, channelBackendRefusal, noteTextRefusal } from "../lib/channel-model.ts";
import { appendChannelNote } from "../lib/channel-store.ts";
import { checkComms } from "../lib/comms-check.ts";
import type { ToolCtx } from "../lib/host.ts";
import { taskKey } from "../lib/owner.ts";
import { readOwnership } from "../lib/ownership.ts";
import { subagentControlRefusal } from "../lib/subagent.ts";
import { commsDetails, commsNoticeLine, findJob, reply, type ToolDeps } from "./kit.ts";

export function registerNoteToWorkerTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_note_to_worker",
		label: "Note To WezTerm Worker",
		description:
			"Write a short note to a worker. " +
			"The note changes no state of the task and it does not wake the worker. " +
			"The worker reads the notes at the start of its next instruction cycle.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker that reads the note."),
			text: z.string().describe("The text of the note. At most 4000 characters."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; text?: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx?: ToolCtx,
		) {
			const refusal = subagentControlRefusal(ctx);
			if (refusal) return reply(refusal, { refused: "subagent" }, true);
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
			const authorityRefusal = controlRefusal(owner, rt.sessionId, job.id);
			if (authorityRefusal) {
				return reply(authorityRefusal, refusalDetails(job.id, owner), true);
			}
			const backendRefusal = channelBackendRefusal(readBackend(job));
			if (backendRefusal) {
				return reply(backendRefusal, { workerId: job.id, refused: "backend" }, true);
			}
			const text = String(params.text ?? "");
			const textRefusal = noteTextRefusal(text);
			if (textRefusal) return reply(textRefusal, { workerId: job.id, noted: false }, true);
			/* The communication check runs before the note reaches the channel.
			   The enforce mode refuses a note that scores below the minimum. */
			const comms = await checkComms(rt.exec, rt.config.ste100Skill, text, "steer", rt.config.commsStandard);
			if (comms.verdict === "fail") {
				return reply(
					`The communication check refused this text. The score is ${comms.score}. ` +
						`The minimum score is ${rt.config.commsStandard.minScore}.`,
					{ workerId: job.id, ...commsDetails(comms), refused: "commsStandard" },
					true,
				);
			}
			let note: ChannelNote;
			try {
				note = appendChannelNote(job.sessionDir, "main", {
					runId: null,
					text: text.trim(),
					at: Date.now(),
				});
			} catch (e) {
				return reply(
					`The note was not saved: ${e instanceof Error ? e.message : String(e)}`,
					{ workerId: job.id, noted: false },
					true,
				);
			}
			const running = job.status === "running" || job.status === "queued";
			const headline = running
				? `The note is in the channel of worker ${job.id}. It is note ${note.seq}.`
				: `The note is in the channel of worker ${job.id}. It is note ${note.seq}. ` +
					"The worker reads the note after a resume.";
			const notice = commsNoticeLine(comms, rt.config.commsStandard);
			if (notice) {
				return reply(`${headline}\n${notice}`, {
					workerId: job.id,
					noted: true,
					seq: note.seq,
					...commsDetails(comms),
				});
			}
			return reply(headline, {
				workerId: job.id,
				noted: true,
				seq: note.seq,
				...commsDetails(comms),
			});
		},
	});
}

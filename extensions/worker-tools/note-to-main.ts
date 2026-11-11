/**
 * wezterm_worker_note_to_main
 *
 * The worker writes a short note to the main session. The note changes no
 * state of the task. The extension never steers the worker when a note
 * arrives, so the note waits until the main session reads it.
 *
 * The tool is worker-only. A worker reads and writes only its own channel.
 */

import { type ChannelNote, noteTextRefusal, noteWrittenText } from "../lib/channel-model.ts";
import { appendChannelNote } from "../lib/channel-store.ts";
import { checkComms } from "../lib/comms-check.ts";
import type { ToolCtx } from "../lib/host.ts";
import { readRunContext } from "../lib/worker-context.ts";
import { commsDetails, commsNoticeLine, reply, type ToolDeps } from "./kit.ts";
import { workerChannelRefusal, workerSessionDir } from "./worker-channel.ts";

export function registerNoteToMainTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	rt.registerWorkerTool({
		name: "wezterm_worker_note_to_main",
		label: "Note To Main Session",
		description:
			"Write a short note to the main session. " +
			"A note changes no state of the task and it does not wake the main session. " +
			"The main session reads the notes with its own tool.",
		parameters: z.object({
			text: z.string().describe("The text of the note. At most 4000 characters."),
		}),
		loadMode: "essential",
		async execute(
			_toolCallId: string,
			params: { text?: string },
			_signal?: unknown,
			_onUpdate?: unknown,
			_ctx?: ToolCtx,
		) {
			const sessionDir = workerSessionDir();
			if (!sessionDir) {
				return reply(
					"This process is not a worker. Only a worker writes a note to the main session.",
					{ noted: false },
					true,
				);
			}
			const context = readRunContext(sessionDir);
			if (!context) {
				return reply(
					"The run context is missing. The worker was not launched by this extension.",
					{ noted: false },
					true,
				);
			}
			const refusal = workerChannelRefusal(context.backend);
			if (refusal) return reply(refusal, { noted: false, refused: "backend" }, true);
			const text = String(params.text ?? "");
			const textRefusal = noteTextRefusal(text);
			if (textRefusal) return reply(textRefusal, { noted: false }, true);
			/* The communication check runs after the text check. The note is
			   always saved. A low score only adds a warning. */
			const comms = await checkComms(rt.exec, rt.config.ste100Skill, text, "result", rt.config.commsStandard);
			let note: ChannelNote;
			try {
				note = appendChannelNote(sessionDir, "worker", {
					runId: context.runId,
					text: text.trim(),
					at: Date.now(),
				});
			} catch (e) {
				return reply(
					`The note was not saved: ${e instanceof Error ? e.message : String(e)}`,
					{ noted: false },
					true,
				);
			}
			const headline = noteWrittenText(note.seq);
			const notice = commsNoticeLine(comms, rt.config.commsStandard);
			if (notice) {
				return reply(`${headline}\n${notice}`, {
					noted: true,
					seq: note.seq,
					runId: context.runId,
					...commsDetails(comms),
				});
			}
			return reply(headline, {
				noted: true,
				seq: note.seq,
				runId: context.runId,
				...commsDetails(comms),
			});
		},
	});
}

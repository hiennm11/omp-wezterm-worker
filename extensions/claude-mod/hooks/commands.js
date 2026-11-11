/**
 * The command poll of a Claude Code worker.
 *
 * The owner sends a steering instruction through the bridge. The mod takes
 * one command at a time and submits it with the native prompt API, so a
 * running tool is not interrupted.
 *
 * A note of the main session follows the same poll. The mod submits it as a
 * prompt of the session, and the host starts a turn with it.
 */

import { observe, readHandover, reportCommand, sendSnapshot, state } from "./owner.js";

/** Take one command from the owner. */
export async function pollCommands($) {
	if (state.closed) return;
	if (!state.baseUrl || !state.token) return;
	try {
		/* The owner address and the token can change when the owner
		   recovers. The mod reads them again on every poll. The handover
		   file holds the bridge of the current owner, so a new owner is
		   found after a release. */
		const handover = await readHandover($);
		const url = handover?.url ?? (await $.env.get("WEZTERM_WORKER_URL")) ?? state.baseUrl;
		const token = handover?.token ?? (await $.env.get("WEZTERM_WORKER_TOKEN")) ?? state.token;
		/* A different address means a different owner. The new owner knows
		   nothing about the run, so the mod owes it a snapshot. */
		if (handover && (handover.url !== state.baseUrl || handover.token !== state.token)) {
			state.snapshotDue = true;
		}
		state.baseUrl = url;
		state.token = token;
		await sendSnapshot($);
		const response = await $.http.fetch(
			`${url}/commands?runId=${encodeURIComponent(state.runId ?? "")}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		/* The owner closed the bridge. A released owner writes the
		   handover file again, so a new owner is found on the next poll. A
		   run that ended removes the file, so the mod stops for good. */
		if (response.status === 410) {
			const next = await readHandover($);
			if (!next) {
				state.closed = true;
				return;
			}
			if (next.url !== state.baseUrl || next.token !== state.token) {
				state.snapshotDue = true;
			}
			state.baseUrl = next.url;
			state.token = next.token;
			await sendSnapshot($);
			return;
		}
		if (!response.ok) return;
		const body = JSON.parse(response.text);
		const command = body?.command;
		if (!command) return;
		state.commands.set(command.id, command);
		await reportCommand($, command.id, "received", null, null);
		await observe($, "command.received", { id: command.id, text: command.text });

		/* A steering instruction is refused while a permission request is
		   open. The request stays with the person in the pane. */
		if (state.pendingApprovals.size > 0) {
			await reportCommand($, command.id, "refused", null, "a permission request is open");
			await observe($, "command.refused", {
				id: command.id,
				reason: "a permission request is open",
				approvals: [...state.pendingApprovals.keys()],
			});
			return;
		}

		const instructionId = `claude-instruction-${command.id}`;
		state.pendingInstructionId = instructionId;
		/* The submit call is the native acceptance. Its promise settles when
		   the turn starts, so the acceptance is recorded at the call and the
		   delivery is recorded by the row that carries the instruction. */
		await reportCommand($, command.id, "accepted", instructionId, null);
		await observe($, "command.accepted", { id: command.id, instructionId });
		void $.prompt
			.submit({ text: command.text })
			.then(async (result) => {
				const drop = result?.drop ?? null;
				if (drop) {
					await reportCommand($, command.id, "refused", null, drop);
					await observe($, "command.refused", { id: command.id, reason: drop });
					return;
				}
				await observe($, "command.submitted", { id: command.id, instructionId });
			})
			.catch(async (error) => {
				const reason = String(error?.message ?? error);
				await reportCommand($, command.id, "refused", null, reason);
				await observe($, "command.refused", { id: command.id, reason });
			});
	} catch {
		/* the next poll tries again */
	}
}

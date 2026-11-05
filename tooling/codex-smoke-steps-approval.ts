/**
 * The step of the Codex smoke test that proves the approval of a command.
 *
 * The step starts a Codex worker with the policy `untrusted`. The extension
 * sends that policy in the request `turn/start`, so the core of Codex asks
 * the person for every command that it does not know. The TUI of the worker
 * shows that dialog.
 *
 * The step never answers the dialog. The person owns that answer. The step
 * only shows that the status tool lists one event of the request, and that
 * a second poll creates no second event.
 */

import { RUNTIME } from "../tests/harness.ts";
import { APPROVAL_POLICY } from "./codex-smoke-home.ts";
import { identityOf, spawnIds, statusText } from "./codex-smoke-ledger.ts";
import {
	cancelWorker,
	currentPaneText,
	delay,
	recordPanes,
	recordThread,
	report,
	type SmokeState,
	textOf,
} from "./codex-smoke-shared.ts";
import { eventCountOf, STEP_NAMES, showsCommandDialog } from "./codex-smoke-steps.ts";

/** The task that makes the worker run a command. */
const APPROVAL_TASK = "Run a shell command that writes APPROVED to approval.txt.";

/** The milliseconds that the step waits for the dialog of the TUI. */
const DIALOG_WAIT_MS = 120_000;

/** The milliseconds that the step waits before it polls the status again. */
const SECOND_POLL_WAIT_MS = 3000;

/**
 * Step 8: the status tool lists one permission request, and a second poll
 * creates no second event.
 *
 * The worker of this step runs with the policy `untrusted`. The extension
 * sends that policy with the turn of the worker, so the core of Codex asks
 * the person for the command. The TUI shows the dialog, and the extension
 * records the event of the request.
 *
 * The policy applies to this worker only. The step restores the old value
 * before it ends, so the other steps of the smoke test keep the policy of
 * the user.
 *
 * The step never sends a key to the pane. The person owns that answer. The
 * step ends the worker with a cancel.
 */
export async function stepPermissionRequest(state: SmokeState): Promise<void> {
	/* The policy applies to the worker of this step only. The other steps
	   of the smoke test need the policy of the user. */
	const policy = RUNTIME.config.codexApprovalPolicy;
	RUNTIME.config.codexApprovalPolicy = APPROVAL_POLICY;
	try {
		const spawned = await state.host.call("wezterm_spawn_worker", {
			task: APPROVAL_TASK,
			cwd: state.repo,
			label: "codex-smoke-approval",
			backend: "codex",
			placement: "tab",
		});
		const ids = spawnIds(spawned);
		if (!ids.workerId || ids.paneId === null) {
			report(
				state,
				"fail",
				STEP_NAMES.permissionRequest,
				`the spawn returned no worker id: ${textOf(spawned)}`,
			);
			return;
		}
		state.workersToCancel.push(ids.workerId);
		try {
			const identity = identityOf(state.stateDir, ids.workerId);
			recordPanes(state, ids.paneId, identity);
			recordThread(state, identity.threadId);

			const deadline = Date.now() + DIALOG_WAIT_MS;
			let count = 0;
			let paneText = "";
			let status = "";
			while (Date.now() < deadline) {
				status = await statusText(state, ids.workerId);
				count = eventCountOf(status, "permission_request");
				paneText = await currentPaneText(ids.paneId);
				if (count > 0 && showsCommandDialog(paneText)) break;
				await delay(2000);
			}
			if (count === 0) {
				report(
					state,
					"not-run",
					STEP_NAMES.permissionRequest,
					"the TUI of Codex asked for no approval. The status lists no event with the condition " +
						`permission_request. The text of the pane shows: ${paneText.replace(/\n/g, " | ")}. ` +
						`The text of the status shows: ${status.replace(/\n/g, " | ")}`,
				);
				return;
			}
			if (!showsCommandDialog(paneText)) {
				report(
					state,
					"fail",
					STEP_NAMES.permissionRequest,
					"the status lists an event of the request, but the TUI of Codex shows no dialog. " +
						`The text of the pane shows: ${paneText.replace(/\n/g, " | ")}. ` +
						`The text of the status shows: ${status.replace(/\n/g, " | ")}`,
				);
				return;
			}

			await delay(SECOND_POLL_WAIT_MS);
			const second = await statusText(state, ids.workerId);
			const countAfter = eventCountOf(second, "permission_request");
			if (countAfter !== count) {
				report(
					state,
					"fail",
					STEP_NAMES.permissionRequest,
					`a second poll found ${countAfter} event(s), not ${count}. ` +
						`The text of the status shows: ${second.replace(/\n/g, " | ")}`,
				);
				return;
			}
			report(
				state,
				"pass",
				STEP_NAMES.permissionRequest,
				`the status lists ${count} event with the condition permission_request; the second poll lists ${countAfter}; ` +
					`the TUI of Codex shows the dialog of the command: ${paneText.replace(/\n/g, " | ")}`,
			);
		} finally {
			await cancelWorker(state, ids.workerId);
		}
	} finally {
		RUNTIME.config.codexApprovalPolicy = policy;
	}
}

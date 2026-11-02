/**
 * The step of the Codex smoke test that proves the approval of a command.
 *
 * The step asks the person for the approval of a shell command and checks
 * that the extension records one event for the request. The smoke test
 * plays the person. The extension never sends the key of the answer.
 */

import { connectAppServer } from "./codex-smoke-client.ts";
import { APPROVAL_POLICY } from "./codex-smoke-home.ts";
import { identityOf, spawnIds, statusText } from "./codex-smoke-ledger.ts";
import {
	cancelWorker,
	currentPaneText,
	delay,
	recordThread,
	report,
	type SmokeState,
	sendKey,
	textOf,
} from "./codex-smoke-shared.ts";
import { eventCountOf, STEP_NAMES, showsCommandDialog } from "./codex-smoke-steps.ts";

/**
 * Step 8: the status tool lists one permission request, and a second poll
 * creates no second event.
 *
 * The config of the user sets the policy of the approval to `never`, so a
 * turn of the worker runs every command without a question. The smoke test
 * starts one turn of the thread of the worker with the policy `untrusted`,
 * so the core of Codex asks the person for the command. The turn runs on the
 * thread of the worker and on the app server of the worker, so the client
 * of the extension sees the native request and records the event.
 *
 * The smoke test plays the person only after it recorded the event. The
 * extension never sends that key.
 */
export async function stepPermissionRequest(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for a task from the person. Do not report anything yet.",
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
		recordThread(state, identity.threadId);
		if (identity.port === null || !identity.threadId) {
			report(
				state,
				"fail",
				STEP_NAMES.permissionRequest,
				"the worker holds no thread, so no turn can ask for an approval",
			);
			return;
		}
		const client = await connectAppServer(`ws://127.0.0.1:${identity.port}`).catch(() => null);
		if (!client) {
			report(state, "fail", STEP_NAMES.permissionRequest, "the app server of the worker does not answer");
			return;
		}
		try {
			const resumed = await client.request("thread/resume", { threadId: identity.threadId });
			if (resumed.error) {
				report(
					state,
					"fail",
					STEP_NAMES.permissionRequest,
					`the observer did not subscribe to the thread: ${resumed.error.message}`,
				);
				return;
			}
			const turn = await client.request("turn/start", {
				threadId: identity.threadId,
				approvalPolicy: APPROVAL_POLICY,
				input: [
					{
						type: "text",
						text: "Run a shell command that writes APPROVED to approval.txt.",
					},
				],
			});
			if (turn.error) {
				report(
					state,
					"fail",
					STEP_NAMES.permissionRequest,
					`the turn that asks for an approval failed: ${turn.error.message}`,
				);
				return;
			}
			const deadline = Date.now() + 120_000;
			let count = 0;
			let dialog = false;
			while (Date.now() < deadline) {
				const text = await statusText(state, ids.workerId);
				count = eventCountOf(text, "permission_request");
				if (count > 0) {
					dialog = showsCommandDialog(await currentPaneText(ids.paneId));
					break;
				}
				await delay(2000);
			}
			if (count === 0) {
				report(
					state,
					"not-run",
					STEP_NAMES.permissionRequest,
					"the TUI of Codex asked for no approval. The turn with the policy untrusted raised no native request",
				);
				return;
			}
			await delay(3000);
			const second = await statusText(state, ids.workerId);
			const countAfter = eventCountOf(second, "permission_request");
			await sendKey(ids.paneId, "\r");
			if (countAfter !== count) {
				report(
					state,
					"fail",
					STEP_NAMES.permissionRequest,
					`a second poll found ${countAfter} event(s), not ${count}`,
				);
				return;
			}
			report(
				state,
				"pass",
				STEP_NAMES.permissionRequest,
				`the status lists ${count} event with the condition permission_request; the second poll lists ${countAfter}; ` +
					`the dialog of the command showed: ${dialog}`,
			);
		} finally {
			client.close();
		}
	} finally {
		await cancelWorker(state, ids.workerId);
	}
}

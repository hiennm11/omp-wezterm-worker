/**
 * The step of the Codex smoke test that checks the config of the user.
 *
 * The app server of Codex writes a trust entry into the config of the user
 * for the folder of the fixture. The step accepts that write and it checks
 * that the rest of the config did not change. The step also reads the
 * command line of the TUI, because the extension must pass no model to it.
 */

import { compareConfigFile } from "./codex-smoke-config.ts";
import { codexConfigFile } from "./codex-smoke-home.ts";
import { identityOf, spawnIds } from "./codex-smoke-ledger.ts";
import { tuiProcessOf } from "./codex-smoke-machine.ts";
import {
	authHash,
	cancelWorker,
	configHash,
	currentCodexRows,
	recordPanes,
	recordThread,
	report,
	type SmokeState,
	textOf,
} from "./codex-smoke-shared.ts";
import { STEP_NAMES } from "./codex-smoke-steps.ts";

/**
 * Step 2: the config and the credentials of Codex keep their hash, and the
 * command line of the TUI names no model.
 */
export async function stepNativeConfig(state: SmokeState): Promise<void> {
	const auth = authHash();
	if (auth !== state.authHashBefore) {
		report(
			state,
			"fail",
			STEP_NAMES.nativeConfig,
			`the credentials of Codex changed: ${state.authHashBefore.slice(0, 12)} -> ${auth.slice(0, 12)}`,
		);
		return;
	}
	/* The step starts its own worker, because a worker that ends closes its
	   own panes and its own process. The TUI of a worker must run while the
	   step reads its command line. */
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything.",
		cwd: state.repo,
		label: "codex-smoke-config",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId) {
		report(state, "fail", STEP_NAMES.nativeConfig, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	state.workersToCancel.push(ids.workerId);
	try {
		const identity = identityOf(state.stateDir, ids.workerId);
		recordPanes(state, ids.paneId, identity);
		recordThread(state, identity.threadId);
		if (identity.port === null) {
			report(
				state,
				"fail",
				STEP_NAMES.nativeConfig,
				"the worker holds no port, so the command line of the TUI is unknown",
			);
			return;
		}
		const rows = await currentCodexRows();
		const tui = tuiProcessOf(rows, identity.port);
		if (!tui) {
			report(state, "fail", STEP_NAMES.nativeConfig, "the process of the TUI is not in the process table");
			return;
		}
		if (/(^|\s)-m(\s|=|$)/.test(tui.commandLine)) {
			report(
				state,
				"fail",
				STEP_NAMES.nativeConfig,
				`the command line of the TUI names a model: ${tui.commandLine}`,
			);
			return;
		}
		/* The app server writes a trust entry into the config of the user
		   for the folder of the fixture. The step accepts that write and it
		   checks that the rest of the file did not change. */
		const comparison = compareConfigFile(
			codexConfigFile(),
			state.configTextBefore,
			state.configHashBefore,
			configHash(),
			state.repo,
		);
		const model = "the command line of the TUI names no model";
		if (comparison.verdict === "changed") {
			report(
				state,
				"fail",
				STEP_NAMES.nativeConfig,
				`the config of Codex changed in another way: ${comparison.differences.join(", ")}; ${model}`,
			);
			return;
		}
		if (comparison.verdict === "unchanged") {
			report(
				state,
				"pass",
				STEP_NAMES.nativeConfig,
				`the config of Codex keeps the hash ${comparison.hashAfter.slice(0, 12)}; ` +
					`the credentials keep the hash ${auth.slice(0, 12)}; ${model}`,
			);
			return;
		}
		report(
			state,
			"pass",
			STEP_NAMES.nativeConfig,
			`the config of Codex changed only by the entry ${comparison.addedEntry}; ` +
				`the hash moved from ${comparison.hashBefore.slice(0, 12)} to ${comparison.hashAfter.slice(0, 12)}; ` +
				`the credentials keep the hash ${auth.slice(0, 12)}; ${model}`,
		);
	} finally {
		await cancelWorker(state, ids.workerId);
	}
}

/**
 * The smoke test of the production Codex backend.
 *
 * The script runs the real extension through its own tools against the real
 * Codex program and the real WezTerm. It proves what the extension does. It
 * closes the criteria of issue 5 that the protocol proof does not close.
 *
 * The script never touches the checkout of the user. It uses a temporary
 * state directory and a temporary Git repository. It closes only the panes
 * and the processes that it created.
 *
 * Run it with:
 *
 *   node tooling/codex-smoke.ts
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The module must load before the extension. It removes the variables that
   make the extension a worker. */
import "./codex-smoke-env.ts";
import { closePane, codexProcessRows, listPaneIds, runProgram } from "./codex-smoke-machine.ts";
import {
	authHash,
	configFileText,
	configHash,
	makeHost,
	makeRepo,
	type SmokeState,
	writeSmokeConfig,
} from "./codex-smoke-shared.ts";
import { runVerdict } from "./codex-smoke-steps.ts";
import { stepPermissionRequest } from "./codex-smoke-steps-approval.ts";
import { stepNativeConfig } from "./codex-smoke-steps-config.ts";
import { stepSpawnAndCancel, stepToolListRefused } from "./codex-smoke-steps-one.ts";
import {
	stepDaemonAndRollout,
	stepDirectInput,
	stepExecutionEvidence,
	stepUnknownBackend,
} from "./codex-smoke-steps-pane.ts";
import { stepRecovery, stepResume } from "./codex-smoke-steps-recovery.ts";
import { stepMcpServers, stepSteerOrder } from "./codex-smoke-steps-server.ts";

/** The steps of the smoke test, in the order of the run. */
const STEPS = [
	stepSpawnAndCancel,
	stepNativeConfig,
	stepToolListRefused,
	stepMcpServers,
	stepSteerOrder,
	stepDirectInput,
	stepExecutionEvidence,
	stepPermissionRequest,
	stepDaemonAndRollout,
	stepUnknownBackend,
	stepRecovery,
	stepResume,
];

/**
 * The name that every folder of the smoke test holds.
 *
 * The cleanup removes a folder only when its name starts with this text.
 */
const FIXTURE_NAME = "codex-smoke-";

/** The root of the repository. The exit rule reads the test files of it. */
const ROOT = join(import.meta.dirname, "..");

/**
 * Build the state of the smoke test.
 *
 * The function builds the host, the temporary state directory and the
 * temporary Git repository. The repository sits in a new folder under the
 * temporary folder of the machine, so the smoke test never writes into a
 * checkout of the user.
 */
function makeState(): SmokeState {
	const stateDir = mkdtempSync(join(tmpdir(), `${FIXTURE_NAME}state-`));
	const parent = mkdtempSync(join(tmpdir(), `${FIXTURE_NAME}repo-`));
	const repo = makeRepo(parent);
	writeSmokeConfig(stateDir);
	return {
		host: makeHost(stateDir, repo),
		stateDir,
		repo,
		fixtureParent: parent,
		ownPanes: new Set(),
		ownProcesses: new Set(),
		workersToCancel: [],
		firstWorkerId: null,
		firstTuiPane: null,
		firstPort: null,
		cancelledThreadId: null,
		ownThreadIds: [],
		lines: [],
		userPanesBefore: [],
		daemonBefore: [],
		configHashBefore: "",
		configTextBefore: "",
		authHashBefore: "",
	};
}

/**
 * Close the panes and the processes that the smoke test created.
 *
 * The function ends only what the smoke test started. It reads the process
 * table and ends a process only when the process id is one that the smoke
 * test recorded and the name of the program is `codex.exe`.
 */
async function cleanUp(state: SmokeState): Promise<void> {
	for (const workerId of state.workersToCancel) {
		await state.host.call("wezterm_worker_cancel", { workerId }).catch(() => undefined);
	}
	for (const pane of state.ownPanes) {
		await closePane(pane).catch(() => undefined);
	}
	const rows = await codexProcessRows();
	for (const pid of state.ownProcesses) {
		const row = rows.find((entry) => entry.processId === pid);
		if (!row) continue;
		if (row.name.toLowerCase() !== "codex.exe") continue;
		await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
	}
	/* A TUI of a thread of the smoke test can outlive its pane. The
	   function ends those processes, and it never touches a process of
	   another thread. */
	const leftovers = leftoverProcesses(await codexProcessRows(), state.ownThreadIds);
	for (const pid of leftovers) {
		await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
	}
	/* The fixture folder of the smoke test holds no work of the user, so the
	   cleanup removes it. The guard keeps the cleanup away from every other
	   folder of the machine. */
	const temp = tmpdir().toLowerCase();
	const parent = state.fixtureParent.toLowerCase();
	if (parent.startsWith(temp) && parent.includes(FIXTURE_NAME)) {
		rmSync(state.fixtureParent, { recursive: true, force: true });
	}
}

/**
 * The processes of Codex that the smoke test left on the machine.
 *
 * The function reads the process table and keeps the processes that run a
 * TUI of one of the threads of the smoke test. The shared daemon of the
 * user runs no TUI, so it stays outside the list.
 */
export function leftoverProcesses(
	rows: Array<{ processId: number; name: string; commandLine: string }>,
	threadIds: string[],
): number[] {
	return rows
		.filter((row) => row.name.toLowerCase() === "codex.exe")
		.filter((row) => row.commandLine.includes("--remote"))
		.filter((row) => threadIds.some((threadId) => row.commandLine.includes(threadId)))
		.map((row) => row.processId);
}

/** The process ids of the shared daemon of the user. */
function daemonIds(rows: Array<{ processId: number; commandLine: string }>): number[] {
	return rows
		.filter(
			(row) => row.commandLine.includes("--managed-daemon") || row.commandLine.includes("app-server daemon"),
		)
		.map((row) => row.processId);
}

/**
 * Run the smoke test.
 *
 * The function runs every step and prints the report. It gives 0 only when
 * every step passed.
 */
async function runSmoke(): Promise<number> {
	const state = makeState();
	state.userPanesBefore = await listPaneIds();
	state.daemonBefore = daemonIds(await codexProcessRows());
	state.configHashBefore = configHash();
	state.configTextBefore = configFileText();
	state.authHashBefore = authHash();

	try {
		for (const step of STEPS) {
			await step(state);
		}
	} catch (error) {
		console.log(
			`FAIL: the smoke test stopped on an error (${error instanceof Error ? error.message : String(error)})`,
		);
	} finally {
		await cleanUp(state);
		await state.host.cleanup().catch(() => undefined);
	}

	const panesAfter = await listPaneIds();
	const daemonsAfter = daemonIds(await codexProcessRows());
	const userPanesStay = state.userPanesBefore.every((pane) => panesAfter.includes(pane));
	const daemonStays = state.daemonBefore.every((pid) => daemonsAfter.includes(pid));
	console.log(`machine after the run: panes ${panesAfter.join(", ")}; daemon ${daemonsAfter.join(", ")}`);
	console.log(
		`the panes of the user survive: ${userPanesStay}; the daemon of the user survives: ${daemonStays}`,
	);

	const verdict = runVerdict(state.lines, (path) => existsSync(join(ROOT, path)));
	if (verdict.reason !== null) console.log(`FAIL: ${verdict.reason}`);
	return verdict.code;
}

process.exit(await runSmoke());

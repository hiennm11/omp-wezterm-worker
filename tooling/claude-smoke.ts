/**
 * The smoke test of the production Claude Code backend.
 *
 * The script runs the real extension through its own tools against the real
 * Claude Code program and the real WezTerm. It proves what the extension
 * does.
 *
 * The script never touches the checkout of the user. It uses a temporary
 * state directory and a temporary Git repository. It closes only the panes
 * and the processes that it created. A pane or a process of the user is
 * never closed, and the script never ends a process by its name alone.
 *
 * Run it with:
 *
 *   node tooling/claude-smoke.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The module must load before the extension. It removes the variables that
   make the extension a worker. */
import "./claude-smoke-env.ts";
import { sessionContext } from "../tests/harness.ts";
import { claudeProcessRows, runProgram } from "./claude-smoke-machine.ts";
import {
	cleanUp,
	currentPanes,
	delay,
	makeHost,
	makeRepo,
	projectEntries,
	recordAllDescendants,
	type SmokeState,
	settingsHash,
	writeSmokeConfig,
} from "./claude-smoke-shared.ts";
import { runVerdict } from "./claude-smoke-steps.ts";
import { stepReportBindsToCycle, stepSpawnAndReport, stepUsage } from "./claude-smoke-steps-one.ts";
import { stepDefaultModel, stepToolsRefused, stepUnknownBackend } from "./claude-smoke-steps-refusal.ts";
import { stepCancel, stepExternalHistory } from "./claude-smoke-steps-three.ts";
import { stepResume, stepSteer } from "./claude-smoke-steps-two.ts";

/** The steps of the smoke test, in the order of the run. */
const STEPS = [
	stepSpawnAndReport,
	stepReportBindsToCycle,
	stepUsage,
	stepToolsRefused,
	stepUnknownBackend,
	stepDefaultModel,
	stepResume,
	stepSteer,
	stepCancel,
	stepExternalHistory,
];

/**
 * The name that every folder of the smoke test holds.
 *
 * The cleanup removes a folder only when its name starts with this text.
 */
const FIXTURE_NAME = "claude-smoke-";

/** The session id of the smoke test. The release needs an owner. */
const SESSION_ID = "claude-smoke-session";

/** The folder that holds the mod of the smoke test. */
const CLAUDE_MOD_DIR = join(import.meta.dirname, "..", "extensions", "claude-mod");

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
		host: makeHost(stateDir, repo, SESSION_ID),
		stateDir,
		repo,
		fixtureParent: parent,
		ownPanes: new Set(),
		ownProcesses: new Set(),
		ownDescendants: new Set(),
		ownWorkers: new Set(),
		workersToCancel: [],
		lines: [],
		userPanesBefore: [],
		settingsHashBefore: "",
		projectEntriesBefore: [],
		firstSessionId: null,
		firstWorkerId: null,
		cancelledSessionId: null,
	};
}

/**
 * Remove the fixture folder of the smoke test.
 *
 * The guard keeps the cleanup away from every other folder of the machine.
 * The folder holds no work of the user, so the cleanup removes it.
 *
 * The program of Claude Code holds the folder of the repository for a moment
 * after it ends. A removal that fails must not hide the result of the smoke
 * test, so the function retries and then reports the folder that stayed.
 */
async function removeFixture(state: SmokeState): Promise<void> {
	const temp = tmpdir().toLowerCase();
	const parent = state.fixtureParent.toLowerCase();
	if (!parent.startsWith(temp) || !parent.includes(FIXTURE_NAME)) return;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(state.fixtureParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
			return;
		} catch {
			await delay(1000);
		}
	}
	console.log(`note: the fixture folder ${state.fixtureParent} is still held by the program of Claude Code`);
}

/**
 * Check that the installed Claude Code accepts the mod of the extension.
 *
 * A mod that the installed CLI refuses never loads. The check runs first,
 * so a broken mod fails fast.
 */
async function checkMod(): Promise<string | null> {
	const result = await runProgram("claude", ["plugin", "validate", CLAUDE_MOD_DIR]);
	if (result.code === 0) return null;
	return `the installed Claude Code refused the mod: ${result.stderr || result.stdout}`;
}

/**
 * Run the smoke test.
 *
 * The function runs every step and prints the report. It gives 0 only when
 * every step passed.
 */
async function runSmoke(): Promise<number> {
	const modFailure = await checkMod();
	if (modFailure !== null) {
		console.log(`FAIL: ${modFailure}`);
		return 1;
	}

	const state = makeState();
	const panesBefore = await currentPanes();
	state.userPanesBefore = panesBefore ?? [];
	state.settingsHashBefore = settingsHash();
	state.projectEntriesBefore = projectEntries();
	const processesBefore = await claudeProcessRows();

	try {
		await state.host.fire("session_start", sessionContext(state.repo, SESSION_ID));
		/* A shell of a command of a worker starts while the worker runs.
		   The recorder reads the descendants of every worker of the smoke
		   test, so the cleanup can end those shells by their id. */
		const recorder = setInterval(() => {
			void recordAllDescendants(state).catch(() => undefined);
		}, 2000);
		recorder.unref?.();
		try {
			for (const step of STEPS) {
				await step(state);
			}
		} finally {
			clearInterval(recorder);
		}
	} catch (error) {
		console.log(
			`FAIL: the smoke test stopped on an error (${error instanceof Error ? error.message : String(error)})`,
		);
	} finally {
		await cleanUp(state);
		await state.host.cleanup().catch(() => undefined);
		await removeFixture(state);
	}

	const panesAfter = await currentPanes();
	const processesAfter = await claudeProcessRows();
	const userPanesStay = state.userPanesBefore.every((pane) => (panesAfter ?? []).includes(pane));
	const userProcessesStay = processesBefore
		.filter((row) => !state.ownProcesses.has(row.processId))
		.every((row) => processesAfter.some((after) => after.processId === row.processId));
	console.log(
		`machine after the run: panes ${(panesAfter ?? []).join(", ")}; ` +
			`processes of Claude Code ${processesAfter.map((row) => row.processId).join(", ") || "none"}`,
	);
	console.log(
		`the panes of the user survive: ${userPanesStay}; the processes of the user survive: ${userProcessesStay}`,
	);

	const verdict = runVerdict(state.lines);
	if (verdict.reason !== null) console.log(`FAIL: ${verdict.reason}`);
	return verdict.code;
}

process.exit(await runSmoke());

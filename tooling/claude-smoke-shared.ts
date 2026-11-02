/**
 * The shared parts of the Claude smoke test.
 *
 * The script runs the real extension through its own tools against the real
 * Claude Code program and the real WezTerm. It proves what the extension
 * does.
 *
 * The script never touches the checkout of the user. It uses a temporary
 * state directory and a temporary Git repository. It closes only the panes
 * and the processes that it created.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createHost, type TestHost } from "../tests/harness.ts";
import { claudeProjectEntries, claudeSettingsFile, hashOfFile } from "./claude-smoke-home.ts";
import {
	claudeProcessRows,
	closePane,
	listPaneIds,
	type ProcessRow,
	runProgram,
} from "./claude-smoke-machine.ts";
import {
	descendantIdsOfWorker,
	descendantIdsOfWorkers,
	processIdOfWorker,
	processIdsOfState,
} from "./claude-smoke-processes.ts";

/** The result of a tool call of the host. */
export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

/** The result of one step of the smoke test. */
export type StepOutcome = "pass" | "fail" | "not-run";

/** One line of the report of the smoke test. */
export interface StepLine {
	/** The verdict of the step. */
	outcome: StepOutcome;
	/** The name of the check of the step. */
	what: string;
	/** The evidence of the step, or the reason that it could not run. */
	evidence: string;
}

/** The state that the smoke test shares between its steps. */
export interface SmokeState {
	/** The host that holds the extension. */
	host: TestHost;
	/** The folder that holds the state of the smoke test. */
	stateDir: string;
	/** The folder that holds the temporary Git repository. */
	repo: string;
	/** The folder under the temporary folder that holds the repository. */
	fixtureParent: string;
	/** The panes that the smoke test created. A tool returned them. */
	ownPanes: Set<number>;
	/** The process ids that the smoke test recorded. */
	ownProcesses: Set<number>;
	/** The process ids that descend from a worker of the smoke test. */
	ownDescendants: Set<number>;
	/** The ids of the workers that the smoke test started. */
	ownWorkers: Set<string>;
	/** The workers that the smoke test started and must cancel. */
	workersToCancel: string[];
	/** The lines of the report of the smoke test. */
	lines: StepLine[];
	/** The pane ids of the user before the run. */
	userPanesBefore: number[];
	/** The hash of the settings of Claude Code before the run. */
	settingsHashBefore: string;
	/** The entries of the folder of the sessions before the run. */
	projectEntriesBefore: string[];
	/** The native session id of the worker of the spawn step. */
	firstSessionId: string | null;
	/** The id of the worker of the spawn step. */
	firstWorkerId: string | null;
	/** The native session id of the worker that the cancel step cancelled. */
	cancelledSessionId: string | null;
}

/**
 * Print one line of the report.
 *
 * The line names the verdict of the step, the check and the evidence.
 */
export function report(state: SmokeState, outcome: StepOutcome, what: string, evidence: string): void {
	state.lines.push({ outcome, what, evidence });
	const prefix = outcome === "pass" ? "PASS" : outcome === "fail" ? "FAIL" : "NOT RUN";
	console.log(`${prefix}: ${what} (${evidence})`);
}

/** Wait for a number of milliseconds. */
export function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Build the temporary Git repository of the smoke test.
 *
 * The repository sits in a new folder under the temporary folder of the
 * machine. The folder holds no repository of the user, so the smoke test
 * never writes into a checkout of the user.
 */
export function makeRepo(parent: string): string {
	const dir = join(parent, "run");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "baseline.txt"), "BASELINE\n", "utf8");
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

/**
 * The text of a tool result.
 *
 * The host holds a helper of the same name. The script uses this one so
 * that a result of a step never depends on the host of a test.
 */
export function textOf(result: ToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

/** The pane ids of the machine now, or null when the list cannot be read. */
export function currentPanes(): Promise<number[] | null> {
	return listPaneIds();
}

/** The rows of the process table of the program of Claude Code now. */
export function currentClaudeRows(): Promise<ProcessRow[]> {
	return claudeProcessRows();
}

/**
 * Record a pane of the smoke test.
 *
 * The function records only a pane that a tool of the smoke test returned.
 * A pane that the smoke test did not create never reaches this list, so the
 * cleanup can never close it.
 */
export function recordPane(state: SmokeState, paneId: number | null | undefined): void {
	if (typeof paneId !== "number") return;
	state.ownPanes.add(paneId);
}

/**
 * Record a process of the smoke test.
 *
 * The function records only a process id that the smoke test read from the
 * process table after it started the worker itself.
 */
export function recordProcess(state: SmokeState, processId: number | null | undefined): void {
	if (typeof processId !== "number") return;
	state.ownProcesses.add(processId);
}

/**
 * Cancel a worker of the smoke test.
 *
 * The function records the processes that descend from the worker before it
 * cancels it. A cancel ends the helper of the worker, and the shell of its
 * last command then loses its parent. The cleanup ends those shells by
 * their id.
 *
 * The function removes the worker from the list of the workers that the
 * cleanup cancels. A step that ends its worker keeps the machine free for
 * the next step.
 */
export async function cancelWorker(state: SmokeState, workerId: string): Promise<void> {
	await recordAllDescendants(state);
	for (const pid of await descendantIdsOfWorker(workerId)) state.ownDescendants.add(pid);
	state.workersToCancel = state.workersToCancel.filter((id) => id !== workerId);
	await state.host.call("wezterm_worker_cancel", { workerId }).catch(() => undefined);
}

/**
 * Record the descendants of every worker of the smoke test.
 *
 * A shell of a command of a worker starts while the worker runs. The
 * recorder reads the descendants of every worker of the smoke test, so the
 * cleanup can end those shells by their id. The recorder never ends a
 * process, and it never records a process of another session.
 */
export async function recordAllDescendants(state: SmokeState): Promise<void> {
	for (const pid of await descendantIdsOfWorkers(state.ownWorkers)) state.ownDescendants.add(pid);
}

/**
 * Record the process of a worker of the smoke test.
 *
 * The command line of the process names the plugin directory of the run.
 * The function records the process id of that run, so the cleanup can end
 * it and the shells that it started. The function never ends a process.
 */
export async function recordWorkerProcess(state: SmokeState, workerId: string): Promise<void> {
	recordProcess(state, await processIdOfWorker(workerId));
}

/**
 * Remember a worker of the smoke test.
 *
 * The cleanup reads the descendants of every worker of the smoke test. The
 * function keeps the id of the worker, so the cleanup finds its process.
 */
export function rememberWorker(state: SmokeState, workerId: string): void {
	state.ownWorkers.add(workerId);
}

/**
 * Write the config file of the smoke test.
 *
 * The file raises the limits of the launches. The smoke test starts more
 * workers than one request allows, because every step starts its own
 * worker. The file lives in the temporary state directory, so the limits of
 * the user stay as they are.
 */
export function writeSmokeConfig(stateDir: string): void {
	const file = join(stateDir, "wezterm-worker.json");
	writeFileSync(file, JSON.stringify({ maxActiveWorkers: 0, maxLaunchesPerRequest: 0 }, null, "\t"), "utf8");
}

/**
 * Build the host of the smoke test.
 *
 * The host loads the real extension. The state directory is temporary, so
 * the smoke test never touches the state of the user.
 *
 * The host holds the session id of the smoke test. The release and the
 * takeover need an owner, so the session must have an identity.
 */
export function makeHost(stateDir: string, repo: string, sessionId: string): TestHost {
	return createHost({ stateDir, cwd: repo, sessionId });
}

/**
 * Close the panes and the processes that the smoke test created.
 *
 * The function ends only what the smoke test started. It closes a pane only
 * when the pane id is one that a tool returned. It ends a process only when
 * the process id is one that the smoke test recorded and the name of the
 * program is the name of Claude Code.
 *
 * An unreadable pane list is not an excuse to close a pane. The list of the
 * panes of the smoke test is enough, because the smoke test knows the ids.
 */
export async function cleanUp(state: SmokeState): Promise<void> {
	for (const workerId of state.workersToCancel) {
		await state.host.call("wezterm_worker_cancel", { workerId }).catch(() => undefined);
	}
	state.workersToCancel = [];
	for (const pane of state.ownPanes) {
		await closePane(pane).catch(() => undefined);
	}
	const rows = await claudeProcessRows();
	for (const pid of state.ownProcesses) {
		const row = rows.find((entry) => entry.processId === pid);
		if (!row) continue;
		if (row.name.toLowerCase() !== "claude.exe") continue;
		await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
	}
	/* A resumed session reuses the plugin directory of its source run, so
	   its process carries the id of the source run. The cleanup finds the
	   processes of the smoke test through the state directory of the smoke
	   test, and it ends only those. */
	for (const pid of await processIdsOfState(state.stateDir)) {
		await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
	}
	/* A worker of Claude Code starts a helper, and the helper starts the
	   shell of every command. A cancelled worker leaves that shell behind,
	   and the shell holds the folder of the repository. The cleanup ends
	   every process that the smoke test recorded, and it ends only those. */
	for (const pid of state.ownDescendants) {
		await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
	}
	/* The descendants that the smoke test did not see before the cancel
	   still descend from a process of the smoke test. The cleanup ends them
	   too. */
	for (const pid of await descendantIdsOfWorkers(state.ownWorkers)) {
		await runProgram("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
	}
	/* A shell needs a moment to end. The folder of the fixture cannot be
	   removed while the shell holds it. */
	if (state.ownDescendants.size > 0) await delay(2000);
}

/** The hash of the settings of Claude Code now. */
export function settingsHash(): string {
	return hashOfFile(claudeSettingsFile());
}

/** The entries of the folder of the sessions of Claude Code now. */
export function projectEntries(): string[] {
	return claudeProjectEntries();
}

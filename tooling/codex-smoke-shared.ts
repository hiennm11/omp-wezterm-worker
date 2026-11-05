/**
 * The shared parts of the Codex smoke test.
 *
 * The script runs the real extension through its own tools against the real
 * Codex program and the real WezTerm. It proves what the extension does.
 *
 * The script never touches the checkout of the user. It uses a temporary
 * state directory and a temporary Git repository. It closes only the panes
 * and the processes that it created.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createHost, type TestHost } from "../tests/harness.ts";
import { type ApprovalPolicy } from "../extensions/lib/codex-approval.ts";
import { loadConfig } from "../extensions/lib/config.ts";
import { APPROVAL_POLICY, codexAuthFile, codexConfigFile, configText, hashOfFile } from "./codex-smoke-home.ts";
import {
	closePane,
	codexProcessRows,
	listPaneIds,
	type ProcessRow,
	paneText,
	runProgram,
	sendKeyToPane,
	sendTextToPane,
} from "./codex-smoke-machine.ts";
import type { StepLine, StepOutcome } from "./codex-smoke-steps.ts";

/** The result of a tool call of the host. */
export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
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
	/** The panes that the smoke test created. */
	ownPanes: Set<number>;
	/** The process ids that the smoke test started. */
	ownProcesses: Set<number>;
	/** The workers that the smoke test started and must cancel. */
	workersToCancel: string[];
	/** The worker of the first step. */
	firstWorkerId: string | null;
	/** The pane of the TUI of the first worker. */
	firstTuiPane: number | null;
	/** The port of the app server of the first worker. */
	firstPort: number | null;
	/** The thread of the cancelled worker. */
	cancelledThreadId: string | null;
	/** The threads of the workers that the smoke test started. */
	ownThreadIds: string[];
	/** The lines of the report of the smoke test. */
	lines: StepLine[];
	/** The pane ids of the user before the run. */
	userPanesBefore: number[];
	/** The process ids of the daemon of the user before the run. */
	daemonBefore: number[];
	/** The hash of the config of Codex before the first spawn. */
	configHashBefore: string;
	/** The text of the config of Codex before the first spawn. */
	configTextBefore: string;
	/** The hash of the credentials of Codex before the first spawn. */
	authHashBefore: string;
}

/**
 * Print one line of the report.
 *
 * The line names the verdict of the step, the check and the evidence.
 */
export function report(state: SmokeState, outcome: StepOutcome, what: string, evidence: string): void {
	state.lines.push({ outcome, what, evidence });
	const prefix =
		outcome === "pass"
			? "PASS"
			: outcome === "fail"
				? "FAIL"
				: outcome === "not-observable"
					? "NOT OBSERVABLE"
					: "NOT RUN";
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
 *
 * The app server of Codex writes a trust entry into the config of the user
 * for the folder of the repository. The smoke test accepts that write and
 * it checks that the rest of the config did not change.
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

/** The pane ids of the machine now. */
export function currentPanes(): Promise<number[]> {
	return listPaneIds();
}

/** The rows of the process table of the Codex program now. */
export function currentCodexRows(): Promise<ProcessRow[]> {
	return codexProcessRows();
}

/** The text of a pane now. */
export function currentPaneText(paneId: number): Promise<string> {
	return paneText(paneId);
}

/** Send text into a pane now. */
export function sendText(paneId: number, text: string): Promise<boolean> {
	return sendTextToPane(paneId, text);
}

/** Send a key into a pane now. */
export function sendKey(paneId: number, key: string): Promise<boolean> {
	return sendKeyToPane(paneId, key);
}

/** Close a pane now. */
export function closeOnePane(paneId: number): Promise<boolean> {
	return closePane(paneId);
}

/** Run a program now. */
export function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return runProgram(bin, args);
}

/** The hash of the config of Codex now. */
export function configHash(): string {
	return hashOfFile(codexConfigFile());
}

/** The hash of the credentials of Codex now. */
export function authHash(): string {
	return hashOfFile(codexAuthFile());
}

/** The text of the config of Codex now. */
export function configFileText(): string {
	return configText();
}

/**
 * Write the config file of the smoke test.
 *
 * The file raises the limits of the launches. The smoke test starts more
 * workers than one request allows, because every step starts its own worker.
 * The file lives in the temporary state directory, so the limits of the user
 * stay as they are.
 *
 * The file names the policy of the approval. The step of the permission
 * request reads the setting from this file, so the step uses the same
 * setting that a user writes.
 */
export function writeSmokeConfig(stateDir: string): void {
	const file = join(stateDir, "wezterm-worker.json");
	const config = {
		maxActiveWorkers: 0,
		maxLaunchesPerRequest: 0,
		codex: { approvalPolicy: APPROVAL_POLICY },
	};
	writeFileSync(file, JSON.stringify(config, null, "\t"), "utf8");
}

/**
 * The policy of the approval that the step of the permission request uses.
 *
 * The policy comes from the config file of the smoke test. The step reads it
 * with the reader of the configuration file, so the step uses the same
 * setting that a user writes.
 */
export function approvalPolicyOf(stateDir: string): ApprovalPolicy | null {
	const file = join(stateDir, "wezterm-worker.json");
	const config = loadConfig(file, {});
	return config.codexApprovalPolicy;
}

/**
 * Cancel a worker of the smoke test.
 *
 * The function cancels the worker and removes it from the list of the
 * workers that the cleanup cancels. A step that ends its worker keeps the
 * machine free for the next step.
 */
export async function cancelWorker(state: SmokeState, workerId: string): Promise<void> {
	state.workersToCancel = state.workersToCancel.filter((id) => id !== workerId);
	await state.host.call("wezterm_worker_cancel", { workerId }).catch(() => undefined);
}

/**
 * Record the thread of a worker of the smoke test.
 *
 * The cleanup ends the TUI processes that run a thread of the smoke test.
 * The function keeps the list of those threads.
 */
export function recordThread(state: SmokeState, threadId: string | null): void {
	if (!threadId) return;
	if (state.ownThreadIds.includes(threadId)) return;
	state.ownThreadIds.push(threadId);
}

/**
 * Record the panes of a worker of the smoke test.
 *
 * The function records the pane that the spawn tool returned and the panes
 * of the identity of the worker. The cleanup closes only these panes. The
 * function never records a pane by a difference of two lists, because a pane
 * that another program opens during the run is not a pane of the smoke test.
 */
export function recordPanes(
	state: SmokeState,
	tuiPaneId: number | null,
	identity: { serverPaneId: number | null; tuiPaneId: number | null },
): void {
	const ids = [tuiPaneId, identity.tuiPaneId, identity.serverPaneId];
	for (const id of ids) {
		if (id === null) continue;
		state.ownPanes.add(id);
	}
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

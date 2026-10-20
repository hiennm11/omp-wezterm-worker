/**
 * The helpers of the Windows trial.
 *
 * A scenario reads the status of one worker, waits for it to end and turns
 * what it saw into checks. Every fact comes from the status tool or from the
 * pane list, so a check reports what happened.
 */

import { spawnSync } from "node:child_process";

import { formatUsage, type UsageReport, usageReport } from "../extensions/lib/usage.ts";
import type { TestHost } from "../tests/harness.ts";
import { currentPanes, detailNumber, detailString, waitFor } from "../tests/harness.ts";
import type { ScenarioResult, TrialCheck } from "./trial-report.ts";

/** The fields of a status row that the trial reads. */
export interface StatusRow {
	status: string | null;
	error: string | null;
	stop: string | null;
	turns: number | null;
	elapsedMs: number | null;
	transcript: string | null;
	usage: UsageReport | null;
}

/** Read one field of a status row. */
function field(row: Record<string, unknown> | null, name: string): unknown {
	if (row === null) return undefined;
	return row[name];
}

/** The status row of one worker, or null when the worker is unknown. */
export async function statusRow(host: TestHost, workerId: string): Promise<Record<string, unknown> | null> {
	const result = await host.call("wezterm_worker_status", { workerId });
	const details = result.details;
	if (typeof details !== "object" || details === null || !("workers" in details)) return null;
	const workers = (details as { workers: unknown }).workers;
	if (!Array.isArray(workers)) return null;
	const first = workers[0];
	if (typeof first !== "object" || first === null) return null;
	return first as Record<string, unknown>;
}

/** The status row of one worker, read into the fields the trial uses. */
export async function readRow(host: TestHost, workerId: string): Promise<StatusRow> {
	const row = await statusRow(host, workerId);
	const usage = field(row, "usage");
	return {
		status: detailString(row, "status"),
		error: detailString(row, "error"),
		stop: detailString(row, "stop"),
		turns: detailNumber(row, "turns"),
		elapsedMs: detailNumber(row, "elapsedMs"),
		transcript: detailString(row, "transcript"),
		usage: typeof usage === "object" && usage !== null && "state" in usage ? (usage as UsageReport) : null,
	};
}

/** Wait until the worker reaches a final status. */
export async function waitForEnd(host: TestHost, workerId: string, timeoutMs: number): Promise<StatusRow> {
	let last: StatusRow = {
		status: null,
		error: null,
		stop: null,
		turns: null,
		elapsedMs: null,
		transcript: null,
		usage: null,
	};
	await waitFor(
		async () => {
			last = await readRow(host, workerId);
			return last.status === "completed" || last.status === "failed" || last.status === "cancelled";
		},
		timeoutMs,
		2_000,
	);
	return last;
}

/** Wait until the worker has done at least one turn. */
export async function waitForTurn(host: TestHost, workerId: string, timeoutMs: number): Promise<StatusRow> {
	let last = await readRow(host, workerId);
	await waitFor(
		async () => {
			last = await readRow(host, workerId);
			return (last.turns ?? 0) >= 1;
		},
		timeoutMs,
		2_000,
	);
	return last;
}

/** Wait for the delivery of a worker result into the main session. */
export async function waitForDelivery(
	host: TestHost,
	workerId: string,
	timeoutMs: number,
): Promise<string | null> {
	let found: string | null = null;
	await waitFor(
		() => {
			const entry = host.delivered.find((text) => text.includes(workerId));
			if (entry === undefined) return false;
			found = entry;
			return true;
		},
		timeoutMs,
		500,
	);
	return found;
}

/** Check that the pane of the worker is gone. */
export async function checkPaneGone(paneId: number | null): Promise<{ pass: boolean; detail: string }> {
	if (paneId === null) return { pass: false, detail: "the spawn returned no pane id" };
	const gone = await waitFor(() => !currentPanes().includes(paneId), 20_000, 500);
	return gone
		? { pass: true, detail: `pane ${paneId} is gone` }
		: { pass: false, detail: `pane ${paneId} is still open` };
}

/**
 * The detail of a delivery, as one line.
 *
 * A delivery holds the answer of the worker over several lines. The report
 * puts every detail on one line, so the line breaks become spaces.
 */
export function deliveryDetail(delivery: string | null): string {
	if (delivery === null) return "no result arrived in the main session";
	const oneLine = delivery.replace(/\s+/g, " ").trim();
	return oneLine.slice(0, 160);
}

/** Check that every pane that existed before the spawn still exists. */
export function checkOtherPanes(before: number[], paneId: number | null): { pass: boolean; detail: string } {
	const open = currentPanes();
	const lost = before.filter((pane) => !open.includes(pane));
	return lost.length === 0
		? { pass: true, detail: `all ${before.length} pane(s) of the user are still open` }
		: { pass: false, detail: `these panes are gone: ${lost.join(", ")}. The worker pane was ${paneId}.` };
}

/** Check that the usage of the worker was measured. */
export function checkUsage(usage: UsageReport | null): { pass: boolean; detail: string } {
	if (usage === null) return { pass: false, detail: "the status row holds no usage" };
	return {
		pass: usage.state === "measured",
		detail: formatUsage(usage),
	};
}

/** Run a command and report the exit code, the output and the last line. */
export function runCommand(
	command: string,
	args: string[],
	cwd: string,
): { code: number; output: string; lastLine: string } {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	return { code: result.status ?? -1, output, lastLine: lines[lines.length - 1] ?? "" };
}

/** The changed paths of a checkout, compared with a branch. */
export function changedPaths(cwd: string, base: string): string[] {
	const result = spawnSync("git", ["diff", "--name-only", base], { cwd, encoding: "utf8" });
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** The result of a spawn call. */
export interface Spawn {
	workerId: string | null;
	paneId: number | null;
	worktreePath: string | null;
	/** The reason the spawn failed, or null when it worked. */
	refusal: string | null;
}

/** Start one worker. */
export async function startWorker(host: TestHost, args: Record<string, unknown>): Promise<Spawn> {
	const result = await host.call("wezterm_spawn_worker", args);
	return {
		workerId: detailString(result.details, "workerId"),
		paneId: detailNumber(result.details, "paneId"),
		worktreePath: detailString(result.details, "worktreePath"),
		refusal: result.isError === true ? host.text(result) : null,
	};
}

/** The result of a scenario that never started a worker. */
export function notStarted(name: string, task: string, detail: string, wallMs: number): ScenarioResult {
	return {
		name,
		task,
		workerId: null,
		status: "not started",
		workerMs: null,
		wallMs,
		usage: usageReport(null, "the worker did not start"),
		transcript: null,
		checks: [{ name: "the scenario ran", pass: false, detail }],
	};
}

/** The checks that every worker that ran must pass. */
export async function commonChecks(
	paneId: number | null,
	row: StatusRow,
	delivery: string | null,
	checks: TrialCheck[],
): Promise<void> {
	checks.push({
		name: "the result was delivered",
		pass: delivery !== null,
		detail: deliveryDetail(delivery),
	});
	const pane = await checkPaneGone(paneId);
	checks.push({ name: "the pane is gone", pass: pane.pass, detail: pane.detail });
	const usage = checkUsage(row.usage);
	checks.push({ name: "usage was measured", pass: usage.pass, detail: usage.detail });
}

/** The result of a scenario that ran a worker. */
export function scenarioResult(
	name: string,
	task: string,
	workerId: string,
	row: StatusRow,
	wallMs: number,
	checks: TrialCheck[],
): ScenarioResult {
	return {
		name,
		task,
		workerId,
		status: row.status ?? "unknown",
		workerMs: row.elapsedMs,
		wallMs,
		usage: row.usage ?? usageReport(null, "the worker did not start"),
		transcript: row.transcript,
		checks,
	};
}

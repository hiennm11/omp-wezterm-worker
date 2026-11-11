/**
 * The host seam of the runner of the worker eval.
 *
 * The module reads the results of the worker tools. It turns the details
 * of a tool result into the fields that the runner needs. The module names
 * no test host, so a test can replace the host with a fake.
 */

import type { UsageReport } from "../../extensions/lib/usage.ts";
import type { ToolResult } from "../../tests/harness.ts";
import type { ExecutionOutcome } from "./types.ts";

/** The time between two reads of the status of a worker. */
const POLL_INTERVAL_MS = 2_000;

/** The host that the runner needs. */
export interface RunnerHost {
	call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
	fire(event: string, ctx: unknown): Promise<void>;
	text(result: ToolResult): string;
}

/** The fields of a status row that the runner reads. */
export interface StatusRow {
	status: string | null;
	error: string | null;
	stop: string | null;
	turns: number | null;
	elapsedMs: number | null;
	transcript: string | null;
	usage: UsageReport | null;
}

/** Wait for a time. */
function sleep(ms: number): Promise<void> {
	const { promise, resolve: done } = Promise.withResolvers<void>();
	setTimeout(done, ms);
	return promise;
}

/** Read a string field of a value. */
function stringField(value: Record<string, unknown>, name: string): string | null {
	const field = value[name];
	return typeof field === "string" ? field : null;
}

/** Read a number field of a value. */
function numberField(value: Record<string, unknown>, name: string): number | null {
	const field = value[name];
	return typeof field === "number" ? field : null;
}

/** Read a string field of the details of a tool result. */
export function detailString(details: unknown, name: string): string | null {
	if (typeof details !== "object" || details === null) return null;
	return stringField(details as Record<string, unknown>, name);
}

/**
 * Read the status row of one worker.
 *
 * The status tool lists the workers of the session. The row of the worker
 * that the runner started holds the status, the turns and the usage.
 */
export function readRow(details: unknown, workerId: string): StatusRow | null {
	if (typeof details !== "object" || details === null) return null;
	const workers = (details as Record<string, unknown>).workers;
	if (!Array.isArray(workers)) return null;
	const rows = workers.filter(
		(row): row is Record<string, unknown> => typeof row === "object" && row !== null,
	);
	const row = rows.find((entry) => entry.workerId === workerId) ?? rows[0];
	if (row === undefined) return null;
	const usage = row.usage;
	return {
		status: stringField(row, "status"),
		error: stringField(row, "error"),
		stop: stringField(row, "stop"),
		turns: numberField(row, "turns"),
		elapsedMs: numberField(row, "elapsedMs"),
		transcript: stringField(row, "transcript"),
		usage: typeof usage === "object" && usage !== null && "state" in usage ? (usage as UsageReport) : null,
	};
}

/** The outcome of the execution of a run, from the status of the worker. */
export function outcomeOf(status: string | null): ExecutionOutcome {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return "unknown";
}

/**
 * Wait until the worker reaches a final status.
 *
 * The runner polls the status every two seconds. It stops when the status
 * is neither `running` nor `queued`. The deadline of the worker plus one
 * minute ends the wait.
 */
export async function waitForEnd(
	host: RunnerHost,
	workerId: string,
	deadlineMs: number,
): Promise<{ row: StatusRow | null; timedOut: boolean }> {
	const deadline = Date.now() + deadlineMs;
	let row: StatusRow | null = null;
	while (true) {
		const result = await host.call("wezterm_worker_status", { workerId });
		row = readRow(result.details, workerId);
		if (row !== null && row.status !== null && row.status !== "running" && row.status !== "queued") {
			return { row, timedOut: false };
		}
		if (Date.now() >= deadline) return { row, timedOut: true };
		await sleep(POLL_INTERVAL_MS);
	}
}

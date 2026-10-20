/**
 * Measuring the tokens a worker used.
 *
 * Every number comes from the transcripts. The extension never estimates a
 * value and never computes a missing one: a value that the transcript does not
 * hold is `unknown`.
 *
 * The usage of a worker covers three sources:
 *
 *  - the assistant turns of the worker itself,
 *  - the assistant turns of its subagents, which live in the same session
 *    folder,
 *  - the side calls that OMP logs as `model_usage` entries.
 *
 * A worker that was resumed reports only what came after the resume, so a
 * baseline is subtracted from the current totals.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Job } from "./job.ts";

/** The token counts of one group of model calls. */
export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	total: number;
}

/** The measured usage of one worker or of a whole request. */
export interface UsageTotals {
	/** Assistant turns of the worker and its subagents. */
	turns: TokenCounts;
	/** Side calls that OMP logs as `model_usage` entries. */
	sideCalls: TokenCounts;
	/** Model calls seen: assistant messages plus `model_usage` entries. */
	calls: number;
	/** Model calls without a valid `usage` object. */
	callsWithoutUsage: number;
	/** Sum of `usage.cost.total`. */
	cost: number;
	/** Transcript files read. */
	files: number;
}

/** How much of the usage is known. */
export type UsageState = "measured" | "partial" | "unknown";

/** The usage of a worker or of a request, with the reason for a gap. */
export interface UsageReport {
	state: UsageState;
	totals: UsageTotals | null;
	cost: number | null;
	note: string | null;
}

/** The usage object of one model call, as OMP writes it. */
interface UsageEntry {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
	reasoningTokens?: unknown;
	cost?: { total?: unknown };
}

/** All token counts are zero. */
export function emptyTotals(): UsageTotals {
	return {
		turns: emptyCounts(),
		sideCalls: emptyCounts(),
		calls: 0,
		callsWithoutUsage: 0,
		cost: 0,
		files: 0,
	};
}

/** All token counts are zero. */
function emptyCounts(): TokenCounts {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

/** A finite number that is not negative, or null. */
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Add the counts of one usage object into a group. */
function addCounts(counts: TokenCounts, usage: UsageEntry): void {
	counts.input += count(usage.input) ?? 0;
	counts.output += count(usage.output) ?? 0;
	counts.cacheRead += count(usage.cacheRead) ?? 0;
	counts.cacheWrite += count(usage.cacheWrite) ?? 0;
	counts.total += count(usage.totalTokens) ?? 0;
	counts.reasoning += count(usage.reasoningTokens) ?? 0;
}

/**
 * Add the content of one transcript to the totals.
 *
 * A line that is not valid JSON is skipped: the file is written while it is
 * read, so a partial line is normal.
 */
export function addUsageLines(totals: UsageTotals, text: string): void {
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; usage?: UsageEntry }; usage?: UsageEntry };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		const isTurn = entry.type === "message" && entry.message?.role === "assistant";
		const isSideCall = entry.type === "model_usage";
		if (!isTurn && !isSideCall) continue;
		totals.calls += 1;
		const usage = isTurn ? entry.message?.usage : entry.usage;
		const valid =
			count(usage?.input) !== null &&
			count(usage?.output) !== null &&
			count(usage?.cacheRead) !== null &&
			count(usage?.cacheWrite) !== null &&
			count(usage?.totalTokens) !== null;
		if (!valid) {
			totals.callsWithoutUsage += 1;
			continue;
		}
		addCounts(isTurn ? totals.turns : totals.sideCalls, usage as UsageEntry);
		const cost = count(usage?.cost?.total);
		if (cost !== null && cost > 0) totals.cost += cost;
	}
}

/**
 * Subtract a baseline from the current totals.
 *
 * Returns null when the current totals are smaller than the baseline. That
 * means the transcript changed in a way the code cannot explain, so the
 * difference is not a count.
 *
 * The file count is not subtracted. It says how many transcripts were read,
 * and a difference that comes from a transcript keeps that count.
 */
export function subtractTotals(current: UsageTotals, baseline: UsageTotals): UsageTotals | null {
	const result = emptyTotals();
	for (const group of ["turns", "sideCalls"] as const) {
		for (const key of Object.keys(current[group]) as Array<keyof TokenCounts>) {
			const value = current[group][key] - baseline[group][key];
			if (value < 0) return null;
			result[group][key] = value;
		}
	}
	const numbers: Array<keyof Omit<UsageTotals, "turns" | "sideCalls">> = [
		"calls",
		"callsWithoutUsage",
		"cost",
	];
	for (const key of numbers) {
		const value = current[key] - baseline[key];
		if (value < 0) return null;
		result[key] = value;
	}
	result.files = current.files;
	return result;
}

/** The report of a set of totals, with the reason for a gap. */
export function usageReport(totals: UsageTotals | null, missingReason: string): UsageReport {
	if (totals === null) return { state: "unknown", totals: null, cost: null, note: missingReason };
	if (totals.files === 0) {
		return { state: "unknown", totals: null, cost: null, note: "no transcript" };
	}
	if (totals.calls - totals.callsWithoutUsage === 0) {
		return {
			state: "unknown",
			totals: null,
			cost: null,
			note: "the transcript holds no usage data",
		};
	}
	const cost = totals.cost > 0 ? totals.cost : null;
	if (totals.callsWithoutUsage > 0) {
		return {
			state: "partial",
			totals,
			cost,
			note: `${totals.callsWithoutUsage} of ${totals.calls} model calls have no usage data`,
		};
	}
	return { state: "measured", totals, cost, note: null };
}

/** The report of a set of workers. */
export function combineReports(reports: UsageReport[]): UsageReport {
	if (reports.length === 0) {
		return {
			state: "unknown",
			totals: null,
			cost: null,
			note: "no worker was launched in this request",
		};
	}
	const totals = emptyTotals();
	for (const report of reports) {
		if (!report.totals) continue;
		for (const group of ["turns", "sideCalls"] as const) {
			for (const key of Object.keys(report.totals[group]) as Array<keyof TokenCounts>) {
				totals[group][key] += report.totals[group][key];
			}
		}
		totals.calls += report.totals.calls;
		totals.callsWithoutUsage += report.totals.callsWithoutUsage;
		totals.cost += report.totals.cost;
		totals.files += report.totals.files;
	}
	const cost = totals.cost > 0 ? totals.cost : null;
	const unknown = reports.filter((report) => report.state === "unknown").length;
	const incomplete = reports.length - reports.filter((report) => report.state === "measured").length;
	if (unknown === reports.length) {
		return { state: "unknown", totals: null, cost: null, note: "no worker reported usage" };
	}
	if (incomplete > 0) {
		return {
			state: "partial",
			totals,
			cost,
			note: `${incomplete} of ${reports.length} workers have no complete usage data`,
		};
	}
	return { state: "measured", totals, cost, note: null };
}

/** The report as one line of text. */
export function formatUsage(report: UsageReport): string {
	if (report.state === "unknown" || !report.totals) {
		return `unknown (${report.note ?? "no usage data"})`;
	}
	const totals = report.totals;
	const turns = totals.turns;
	const side = totals.sideCalls;
	const input = turns.input + side.input;
	const output = turns.output + side.output;
	const reasoning = turns.reasoning + side.reasoning;
	const cacheRead = turns.cacheRead + side.cacheRead;
	const cacheWrite = turns.cacheWrite + side.cacheWrite;
	const total = turns.total + side.total;
	const note = report.note ? `; ${report.note}` : "";
	const cost = report.cost === null ? "unknown" : report.cost.toFixed(4);
	return (
		`${total} tokens, ${report.state} (input ${input}, output ${output} incl. reasoning ${reasoning}, ` +
		`cache read ${cacheRead}, cache write ${cacheWrite}; side calls ${side.total})${note}; cost ${cost}`
	);
}

/** The transcript files in a session directory, including the subagent folders. */
export function transcriptFiles(sessionDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) found.push(path);
		}
	};
	walk(sessionDir);
	return found;
}

/** The measured usage of every transcript in a session directory. */
export function readUsageTotals(sessionDir: string): UsageTotals {
	const totals = emptyTotals();
	for (const file of transcriptFiles(sessionDir)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		addUsageLines(totals, text);
		totals.files += 1;
	}
	return totals;
}

/**
 * The usage of one worker.
 *
 * A resumed worker reports only what came after the resume, so the baseline
 * is subtracted from the current totals.
 */
export function jobUsage(job: Job): UsageReport {
	const current = readUsageTotals(job.sessionDir);
	if (job.usageBaseline === null) return usageReport(current, "");
	const difference = subtractTotals(current, job.usageBaseline);
	return usageReport(difference, "the transcript changed since the resume, so the count cannot be split");
}

/** The ids of the workers of this request that reached a pane. */
export function requestWorkerIds(jobs: ReadonlyMap<string, Job>, ids: readonly string[]): string[] {
	return ids.filter((id) => {
		const job = jobs.get(id);
		return job !== undefined && job.startedAt !== null;
	});
}

/** The usage of every worker of this request. */
export function requestUsage(jobs: ReadonlyMap<string, Job>, ids: readonly string[]): UsageReport {
	const kept = requestWorkerIds(jobs, ids);
	return combineReports(kept.map((id) => jobUsage(jobs.get(id) as Job)));
}

/** Rebuild the totals of a persisted job, or null when the value is not usable. */
export function restoreUsageTotals(value: unknown): UsageTotals | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	for (const group of ["turns", "sideCalls"] as const) {
		const counts = entry[group];
		if (typeof counts !== "object" || counts === null) return null;
		const record = counts as Record<string, unknown>;
		for (const key of Object.keys(emptyCounts()) as Array<keyof TokenCounts>) {
			if (count(record[key]) === null) return null;
		}
	}
	for (const key of ["calls", "callsWithoutUsage", "cost", "files"] as const) {
		if (count(entry[key]) === null) return null;
	}
	return {
		turns: entry.turns as TokenCounts,
		sideCalls: entry.sideCalls as TokenCounts,
		calls: entry.calls as number,
		callsWithoutUsage: entry.callsWithoutUsage as number,
		cost: entry.cost as number,
		files: entry.files as number,
	};
}

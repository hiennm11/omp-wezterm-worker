/**
 * The report store of a session directory.
 *
 * The reports live beside the transcript. A separate registry writer would
 * split the evidence in two places.
 */

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkerReport } from "./report-model.ts";

/**
 * The file that holds the reports of one run.
 *
 * A resumed run shares the session directory of its source run. The file
 * name carries the run, so the reports of the two runs stay apart.
 */
export function reportFile(sessionDir: string, runId?: string): string {
	const suffix = runId ? `-${runId}` : "";
	return `${sessionDir}/.wezterm-worker-reports${suffix}.jsonl`;
}

/**
 * Append one report to the report file of a run.
 *
 * The write is one append. A report that fails to write is not a report.
 */
export function appendReport(sessionDir: string, report: WorkerReport): void {
	const line = `${JSON.stringify({ ...report, at: Date.now() })}\n`;
	appendFileSync(reportFile(sessionDir, report.runId), line, "utf8");
}

/**
 * Read the reports of a session directory.
 *
 * With a run id, only the reports of that run count. Without one, the
 * reports of every run in the directory count. A resumed run shares the
 * session directory of its source run, so the reports of both live there.
 * A line that is not valid JSON is skipped.
 */
export function readReports(sessionDir: string, runId?: string): WorkerReport[] {
	const files = runId === undefined ? reportFilesOf(sessionDir) : [reportFile(sessionDir, runId)];
	const reports: WorkerReport[] = [];
	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as WorkerReport;
				if (!parsed || typeof parsed.runId !== "string") continue;
				if (runId !== undefined && parsed.runId !== runId) continue;
				reports.push(parsed);
			} catch {
				/* a partial line is normal while the file is written */
			}
		}
	}
	return reports;
}

/**
 * The report files of a session directory.
 *
 * A file name that does not start with the prefix holds no report.
 */
function reportFilesOf(sessionDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(sessionDir);
	} catch {
		return [];
	}
	const prefix = ".wezterm-worker-reports";
	return entries
		.filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
		.map((name) => join(sessionDir, name));
}

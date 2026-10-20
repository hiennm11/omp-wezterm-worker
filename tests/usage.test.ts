/**
 * The measured token usage of a worker.
 *
 * Every number in the output comes from a transcript. The tests build the
 * transcript lines themselves, so the expected values are a fact and not a
 * guess.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import {
	addUsageLines,
	combineReports,
	emptyTotals,
	formatUsage,
	jobUsage,
	readUsageTotals,
	requestUsage,
	requestWorkerIds,
	restoreUsageTotals,
	subtractTotals,
	usageReport,
} from "../extensions/lib/usage.ts";

/** The usage object of one model call. */
function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		input: 10,
		output: 5,
		cacheRead: 100,
		cacheWrite: 0,
		totalTokens: 115,
		reasoningTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

/** One assistant turn line. */
function turn(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [], usage: usage(overrides) },
	});
}

/** One side call line. */
function sideCall(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: "model_usage", purpose: "auto-thinking", usage: usage(overrides) });
}

/** The totals of one transcript file with these lines. */
function totalsOf(lines: string[]): ReturnType<typeof emptyTotals> {
	const totals = emptyTotals();
	addUsageLines(totals, lines.join("\n"));
	totals.files = 1;
	return totals;
}

/** A job with a session folder and no baseline. */
function job(sessionDir: string, overrides: Partial<Job> = {}): Job {
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		startedAt: 1,
		...overrides,
	};
}

/** A session folder with the given files. */
function sessionFolder(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-usage-"));
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return dir;
}

test("two turns and one side call are summed and shown", () => {
	const totals = totalsOf([turn(), turn(), sideCall({ totalTokens: 50 })]);
	const text = formatUsage(usageReport(totals, ""));
	assert.ok(text.startsWith("280 tokens, measured (input "), text);
	assert.match(text, /side calls 50/);
	assert.ok(text.endsWith("cost unknown"), text);
});

test("a model call without usage makes the count partial", () => {
	const totals = totalsOf([
		JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
		turn(),
	]);
	const report = usageReport(totals, "");
	assert.equal(report.state, "partial");
	assert.equal(report.note, "1 of 2 model calls have no usage data");
});

test("a transcript without a model call has no usage data", () => {
	const totals = totalsOf([JSON.stringify({ type: "message", message: { role: "user", content: [] } })]);
	assert.equal(formatUsage(usageReport(totals, "")), "unknown (the transcript holds no usage data)");
});

test("a cost above zero is shown with four decimals", () => {
	const totals = totalsOf([
		turn({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } }),
	]);
	assert.ok(formatUsage(usageReport(totals, "")).endsWith("cost 0.2500"));
});

test("a broken line between valid lines is skipped", () => {
	const totals = totalsOf([turn(), "{not json", turn()]);
	assert.equal(totals.calls, 2);
	assert.equal(totals.callsWithoutUsage, 0);
});

test("the transcript of a subagent counts as the usage of the worker", () => {
	const dir = sessionFolder({
		"a.jsonl": `${turn()}\n`,
		"a/Sub.jsonl": `${turn()}\n`,
		"a/Sub.md": "not a transcript",
	});
	try {
		const totals = readUsageTotals(dir);
		assert.equal(totals.files, 2);
		assert.equal(totals.calls, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resumed worker reports only the turns after the resume", () => {
	const dir = sessionFolder({ "a.jsonl": `${turn()}\n` });
	try {
		const baseline = readUsageTotals(dir);
		writeFileSync(join(dir, "a.jsonl"), `${turn()}\n${turn()}\n`, "utf8");
		const report = jobUsage(job(dir, { usageBaseline: baseline }));
		assert.equal(report.state, "measured");
		assert.equal(report.totals?.turns.total, 115);
		assert.equal(report.totals?.calls, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a transcript that shrank since the resume has no usage", () => {
	const dir = sessionFolder({ "a.jsonl": `${turn()}\n${turn()}\n` });
	try {
		const baseline = readUsageTotals(dir);
		writeFileSync(join(dir, "a.jsonl"), `${turn()}\n`, "utf8");
		const report = jobUsage(job(dir, { usageBaseline: baseline }));
		assert.equal(report.state, "unknown");
		assert.match(report.note ?? "", /changed since the resume/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("one worker without usage makes the request partial", () => {
	const measured = totalsOf([turn()]);
	const combined = combineReports([usageReport(measured, ""), usageReport(null, "x")]);
	assert.equal(combined.state, "partial");
	assert.equal(combined.note, "1 of 2 workers have no complete usage data");
	assert.equal(combineReports([]).state, "unknown");
	assert.equal(combineReports([usageReport(null, "x")]).state, "unknown");
});

test("a worker with an incomplete count keeps the request partial", () => {
	const partial = totalsOf([turn()]);
	partial.callsWithoutUsage = 1;
	const measured = totalsOf([turn()]);
	const combined = combineReports([usageReport(partial, ""), usageReport(measured, "")]);
	assert.equal(combined.state, "partial");
	assert.equal(combined.note, "1 of 2 workers have no complete usage data");
});

test("a launch that failed before its pane has no usage of its own", () => {
	const dir = sessionFolder({ "a.jsonl": `${turn()}\n` });
	try {
		const jobs = new Map<string, Job>([
			["wz-1", job(dir)],
			["wz-2", job(dir, { id: "wz-2", startedAt: null })],
		]);
		assert.deepEqual(requestWorkerIds(jobs, ["wz-1", "wz-2"]), ["wz-1"]);
		const report = requestUsage(jobs, ["wz-1", "wz-2"]);
		assert.equal(report.state, "measured");
		assert.equal(report.totals?.calls, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a persisted baseline comes back equal, and a broken one comes back as null", () => {
	const totals = totalsOf([turn()]);
	assert.deepEqual(restoreUsageTotals(JSON.parse(JSON.stringify(totals))), totals);
	assert.equal(restoreUsageTotals({ calls: "x" }), null);
});

test("the difference of two totals is the usage of the second run", () => {
	const first = totalsOf([turn()]);
	const second = totalsOf([turn(), turn()]);
	const difference = subtractTotals(second, first);
	assert.equal(difference?.turns.total, 115);
	assert.equal(difference?.calls, 1);
	assert.equal(subtractTotals(first, second), null);
});

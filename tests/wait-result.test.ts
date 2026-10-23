/**
 * The settlement of a background job that a wait result names.
 *
 * A worker reads a background job with the tool wait. The result of that tool
 * names the job and its status. A job with a final status settles its row.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import type { LifecycleDb } from "../extensions/lib/db.ts";
import { executionsOfRun } from "../extensions/lib/executions.ts";
import { completionBlockerOf, syncExecutions } from "../extensions/lib/ledger-sync.ts";
import { freshDb, writeTranscript } from "./execution-helpers.ts";

/** A user message that starts a cycle. */
const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

/** A tool call in an assistant message. */
function call(id: string, name: string): unknown {
	return {
		type: "message",
		id: `m-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name }] },
	};
}

/** A tool result that starts a background job. */
function backgroundResult(id: string, jobId: string): unknown {
	return {
		type: "message",
		id: `r-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "started" }],
			details: { async: { state: "running", jobId, type: "bash" } },
		},
	};
}

/** The entry that names a finished background job. */
function asyncResult(jobId: string, status: string): unknown {
	return {
		type: "custom_message",
		customType: "async-result",
		details: { jobs: [{ jobId, type: "bash", status }] },
	};
}

/** One job of a wait result. */
function waitJob(id: string, status: string): unknown {
	return {
		id,
		type: "bash",
		status,
		label: "sleep 240 && echo slept",
		durationMs: 240229,
		resultText: "slept",
	};
}

/** The result of the tool wait that names the given jobs. */
function waitResult(callId: string, jobs: unknown[]): unknown {
	return {
		type: "message",
		id: "e1568d59",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "wait",
			content: [{ type: "text", text: "## Completed (1) …" }],
			details: {
				op: "wait",
				meta: { source: { type: "report", value: "background jobs snapshot" } },
				jobs,
			},
		},
		isError: false,
	};
}

/** The row of one job in a run. */
function rowOfJob(db: LifecycleDb, runId: string, jobId: string) {
	return executionsOfRun(db, runId).find((row) => row.jobId === jobId);
}

/** A transcript that starts a job and reads it with the tool wait. */
function transcriptWithWait(jobs: unknown[]): unknown[] {
	return [
		USER,
		call("call-1", "bash"),
		backgroundResult("call-1", "bg_1"),
		call("call-2", "wait"),
		waitResult("call-2", jobs),
	];
}

test("a wait result with a completed job settles the row of that job", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithWait([waitJob("bg_1", "completed")]));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wait result with a failed job settles the row of that job", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithWait([waitJob("bg_1", "failed")]));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wait result with a cancelled job settles the row of that job", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithWait([waitJob("bg_1", "cancelled")]));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wait result with a running job keeps the row open", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithWait([waitJob("bg_1", "running")]));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "open", "a job that still runs keeps its row open");
		assert.ok(completionBlockerOf(db, "run-1"), "the open row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wait result and an async result for the same job settle the row once", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			...transcriptWithWait([waitJob("bg_1", "completed")]),
			asyncResult("bg_1", "failed"),
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const rows = executionsOfRun(db, "run-1");
		const settled = rows.filter((row) => row.jobId === "bg_1");
		assert.equal(settled.length, 1, "the job has one row");
		assert.equal(settled[0].state, "settled");
		assert.equal(
			settled[0].settlementEvidence,
			"background job completed",
			"the second signal does not overwrite the settlement evidence",
		);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wait result without jobs changes nothing", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithWait([]));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "open", "a wait result without a job settles no row");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an interrupted wait result changes nothing", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash"),
			backgroundResult("call-1", "bg_1"),
			call("call-2", "wait"),
			{
				type: "message",
				id: "e1568d59",
				message: {
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "wait",
					content: [{ type: "text", text: "## Interrupted" }],
					details: { op: "wait", interrupted: true, jobs: [waitJob("bg_1", "completed")] },
				},
			},
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "open", "an interrupted wait settles no row");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an async result with a running job keeps the row open", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash"),
			backgroundResult("call-1", "bg_1"),
			asyncResult("bg_1", "running"),
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "open", "a job that still runs keeps its row open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wait result for a job without a row creates no row", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			...transcriptWithWait([waitJob("bg_1", "completed"), waitJob("bg_unknown", "completed")]),
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows.filter((row) => row.jobId === "bg_unknown").length, 0, "the unknown job opens no row");
		const known = rowOfJob(db, "run-1", "bg_1");
		assert.ok(known, "the background job has a row");
		assert.equal(known.state, "settled", "the known job settles");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

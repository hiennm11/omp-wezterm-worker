/**
 * The settlement of a background job that the transcript names.
 *
 * A worker runs a command that takes long. OMP moves the command to the
 * background and names the job. The transcript holds the end of the job in
 * one of several shapes. A row settles when a shape names a terminal status.
 * A job without a terminal status keeps its row open, and the blocker names
 * the job and its command.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import type { LifecycleDb } from "../extensions/lib/db.ts";
import { executionsOfRun } from "../extensions/lib/executions.ts";
import { completionBlockerOf, syncExecutions } from "../extensions/lib/ledger-sync.ts";
import { freshDb, writeTranscript } from "./execution-helpers.ts";

/** The command that the measured background call ran. */
const COMMAND = "sleep 65; echo done";

/** A user message that starts a cycle. */
const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

/** A tool call in an assistant message. */
function call(id: string, name: string, args: Record<string, unknown> = {}): unknown {
	return {
		type: "message",
		id: `m-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	};
}

/** The tool result that starts a background job. */
function backgroundResult(id: string, jobId: string): unknown {
	return {
		type: "message",
		id: `r-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: `Backgrounded as job ${jobId}` }],
			details: { async: { state: "running", jobId, type: "bash" }, timeoutSeconds: 300 },
		},
	};
}

/** The result of a read of a background job. */
function readResult(id: string, jobId: string, status: string): unknown {
	return {
		type: "message",
		id: `r-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: `${jobId} [bash] — ${status}` }],
			details: {
				contentType: "text/plain",
				proc: {
					job: { id: jobId, type: "bash", status, label: COMMAND, durationMs: 64322 },
					log: "",
				},
			},
		},
	};
}

/** The result of a kill of a background job. */
function killResult(id: string, jobId: string): unknown {
	return {
		type: "message",
		id: `r-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "write",
			content: [{ type: "text", text: `Cancelled background job ${jobId}` }],
			details: {
				proc: {
					op: "cancel",
					jobs: [{ id: jobId, type: "bash", status: "cancelled", label: COMMAND }],
					cancelled: [{ id: jobId, status: "cancelled" }],
				},
			},
		},
	};
}

/** The entry that OMP writes when the job ends. */
function asyncResult(jobId: string, status: string): unknown {
	return {
		type: "custom_message",
		customType: "async-result",
		details: {
			meta: { source: { type: "report", value: "background job delivery" } },
			jobs: [{ jobId, type: "bash", status, label: COMMAND, durationMs: 65048 }],
		},
	};
}

/** The row of one job in a run. */
function rowOfJob(db: LifecycleDb, runId: string, jobId: string) {
	return executionsOfRun(db, runId).find((row) => row.jobId === jobId);
}

/** The transcript of the measured run, without the end of the job. */
function transcriptWithoutEnd(jobId: string): unknown[] {
	return [
		USER,
		call("call-1", "bash", { command: COMMAND }),
		backgroundResult("call-1", jobId),
		call("call-2", "read", { path: `proc://${jobId}` }),
		readResult("call-2", jobId, "running"),
	];
}

test("the result of a read of a background job settles the row of that job", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			...transcriptWithoutEnd("bg_1"),
			readResult("call-3", "bg_1", "completed"),
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled", "the read of the job names its end");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the result of a kill of a background job settles the row of that job", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			...transcriptWithoutEnd("bg_1"),
			killResult("call-3", "bg_1"),
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled", "the kill of the job names its end");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the tool result of a background call names its job and its command", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithoutEnd("bg_1"));
		const ledger = readCallLedger(file);
		assert.equal(ledger.calls[0].jobId, "bg_1", "the result names the job");
		assert.equal(ledger.calls[0].command, COMMAND, "the call names its command");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a terminal status in the result of the background call settles the row", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash", { command: COMMAND }),
			{
				type: "message",
				id: "r-call-1",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "Backgrounded as job bg_1" }],
					details: { async: { state: "completed", jobId: "bg_1", type: "bash" } },
				},
			},
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled", "the result of the call names the end of the job");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the entries of the measured run settle the row of the background job", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			...transcriptWithoutEnd("bg_1"),
			asyncResult("bg_1", "completed"),
		]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "settled", "the follow-up entry settles the row");
		assert.equal(completionBlockerOf(db, "run-1"), null, "no row blocks the completion");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a background job without a terminal status keeps its row open", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithoutEnd("bg_1"));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const row = rowOfJob(db, "run-1", "bg_1");
		assert.ok(row, "the background job has a row");
		assert.equal(row.state, "open", "a job without an end keeps its row open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the blocker names the background job and its command", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", transcriptWithoutEnd("bg_1"));
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const blocker = completionBlockerOf(db, "run-1");
		assert.ok(blocker, "the open row blocks the completion");
		assert.match(blocker, /bg_1/, "the blocker names the job");
		assert.match(blocker, /sleep 65; echo done/, "the blocker names the command");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

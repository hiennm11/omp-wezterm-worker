/**
 * The execution ledger of a run.
 *
 * The ledger holds one row for every call that a run issued. A row settles
 * when the evidence of its result arrives. A row that never settles blocks
 * the completion report of the run.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import { eventsOfRun, readEvent } from "../extensions/lib/events.ts";
import { executionsOfRun, outstandingExecutions } from "../extensions/lib/executions.ts";
import { closeLedger, completionBlockerOf, syncExecutions } from "../extensions/lib/ledger-sync.ts";
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

/** A tool result that settles the call with the same id. */
function result(id: string): unknown {
	return {
		type: "message",
		id: `r-${id}`,
		message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] },
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

test("a call without a result leaves one outstanding row, and the result settles it", () => {
	const { db, dir } = freshDb();
	try {
		const first = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash")]);
		syncExecutions(db, "run-1", readCallLedger(first), 0, 1000);
		const open = outstandingExecutions(db, "run-1");
		assert.equal(open.length, 1, "the call without a result is outstanding");
		assert.equal(open[0].callId, "call-1");
		assert.equal(open[0].state, "open");

		const second = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash"), result("call-1")]);
		syncExecutions(db, "run-1", readCallLedger(second), 0, 1100);
		assert.equal(outstandingExecutions(db, "run-1").length, 0, "the result settles the row");
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "tool result");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a call at or before the baseline turn opens no row", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash")]);
		syncExecutions(db, "run-1", readCallLedger(file), 1, 1000);
		assert.equal(executionsOfRun(db, "run-1").length, 0, "the call belongs to an earlier run");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a call to the report tool opens no row", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "wezterm_worker_report")]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		assert.equal(executionsOfRun(db, "run-1").length, 0, "the report file is its own evidence");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a background call stays outstanding until the async result names its job", () => {
	const { db, dir } = freshDb();
	try {
		const first = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash"),
			backgroundResult("call-1", "bg_5"),
		]);
		syncExecutions(db, "run-1", readCallLedger(first), 0, 1000);
		const open = outstandingExecutions(db, "run-1");
		assert.equal(open.length, 1, "the background call is still outstanding");
		assert.equal(open[0].kind, "background");
		assert.equal(open[0].jobId, "bg_5");

		const second = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash"),
			backgroundResult("call-1", "bg_5"),
			asyncResult("bg_5", "completed"),
		]);
		syncExecutions(db, "run-1", readCallLedger(second), 0, 1100);
		assert.equal(outstandingExecutions(db, "run-1").length, 0, "the async result settles the job");
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "background job completed");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second sync of the same transcript writes nothing", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash")]);
		const ledger = readCallLedger(file);
		syncExecutions(db, "run-1", ledger, 0, 1000);
		const before = db.handle.prepare("SELECT total_changes() AS n").get() as { n: number };
		syncExecutions(db, "run-1", ledger, 0, 1100);
		const after = db.handle.prepare("SELECT total_changes() AS n").get() as { n: number };
		assert.equal(after.n, before.n, "the second sync changed no row");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closeLedger turns an open row into unknown and creates one execution loss event", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash")]);
		const job = {
			id: "run-1",
			sessionDir: dir,
			sessionFile: file,
			baselineTurns: 0,
		};
		closeLedger(db, job, 1000);
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "unknown");

		const events = eventsOfRun(db, "run-1");
		assert.equal(events.length, 1, "the run holds one event");
		assert.equal(events[0].condition, "execution_loss");
		assert.equal(events[0].id, "ev-run-1-ledger-execution_loss");
		assert.equal(events[0].actionable, true);

		closeLedger(db, job, 1100);
		assert.equal(eventsOfRun(db, "run-1").length, 1, "a second close creates no second event");
		assert.ok(readEvent(db, "ev-run-1-ledger-execution_loss"));
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a sync never reopens a row that is unknown", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash")]);
		const ledger = readCallLedger(file);
		syncExecutions(db, "run-1", ledger, 0, 1000);
		closeLedger(db, { id: "run-1", sessionDir: dir, sessionFile: file, baselineTurns: 0 }, 1100);
		assert.equal(executionsOfRun(db, "run-1")[0].state, "unknown");

		syncExecutions(db, "run-1", ledger, 0, 1200);
		assert.equal(executionsOfRun(db, "run-1")[0].state, "unknown", "the row stays unknown");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the completion blocker names the outstanding rows of a run", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash")]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		const blocker = completionBlockerOf(db, "run-1");
		assert.ok(blocker, "the outstanding row blocks the completion");
		assert.match(blocker, /1 execution\(s\) are still outstanding/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run with no outstanding row has no completion blocker", () => {
	const { db, dir } = freshDb();
	try {
		const file = writeTranscript(dir, "a.jsonl", [USER, call("call-1", "bash"), result("call-1")]);
		syncExecutions(db, "run-1", readCallLedger(file), 0, 1000);
		assert.equal(completionBlockerOf(db, "run-1"), null);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the parser reads the job id of a background call from the result details", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-ledger-"));
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash"),
			backgroundResult("call-1", "bg_9"),
		]);
		const ledger = readCallLedger(file);
		assert.equal(ledger.calls.length, 1);
		assert.equal(ledger.calls[0].jobId, "bg_9");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the parser reads the finished background jobs of a transcript", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-ledger-"));
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			USER,
			call("call-1", "bash"),
			backgroundResult("call-1", "bg_9"),
			asyncResult("bg_9", "failed"),
		]);
		const ledger = readCallLedger(file);
		assert.equal(ledger.backgroundResults.length, 1);
		assert.equal(ledger.backgroundResults[0].jobId, "bg_9");
		assert.equal(ledger.backgroundResults[0].status, "failed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

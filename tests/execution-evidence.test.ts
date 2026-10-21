import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCallLedger, unsettledCalls } from "../extensions/lib/calls.ts";
import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import {
	findByCallId,
	markOpenUnknown,
	openExecution,
	outstandingExecutions,
	settleByCallId,
} from "../extensions/lib/executions.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-exec-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** Write a transcript that holds the given lines. */
function writeTranscript(dir: string, name: string, lines: unknown[]): string {
	const file = join(dir, name);
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
	return file;
}

test("two open tool calls settle one by one", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-1", "run-1", "tool", "read", "call-1", null, "turn 1", "transcript", 1000);
		openExecution(db, "ex-2", "run-1", "tool", "read", "call-2", null, "turn 1", "transcript", 1001);
		assert.equal(outstandingExecutions(db, "run-1").length, 2);

		const settled = settleByCallId(db, "run-1", "call-1", "result of call-1", 1002);
		assert.ok(settled);
		assert.equal(settled.callId, "call-1");
		assert.equal(settled.state, "settled");

		const open = outstandingExecutions(db, "run-1");
		assert.equal(open.length, 1, "one result cannot clear both calls");
		assert.equal(open[0].callId, "call-2");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a result for another call never settles a call", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-1", "run-1", "tool", "read", "call-1", null, "turn 1", "transcript", 1000);
		const settled = settleByCallId(db, "run-1", "call-other", "result of another call", 1001);
		assert.equal(settled, null);
		assert.equal(outstandingExecutions(db, "run-1").length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an execution record survives a restart and still blocks completion", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-1", "run-1", "background", "job", "call-1", "job-9", "turn 1", "transcript", 1000);
		// The process ends. The database keeps the record.
		db.close();
		const again = openDatabase(join(dir, "lifecycle.db"));
		try {
			const open = outstandingExecutions(again, "run-1");
			assert.equal(open.length, 1, "the record survives the restart");
			assert.equal(open[0].state, "open");
		} finally {
			again.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown execution blocks completion until it settles", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-1", "run-1", "tool", "bash", "call-1", null, "turn 1", "transcript", 1000);
		markOpenUnknown(db, "run-1", 1001);
		const open = outstandingExecutions(db, "run-1");
		assert.equal(open.length, 1);
		assert.equal(open[0].state, "unknown");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the parser pairs a tool call with the result that carries its id", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-calls-"));
	try {
		const file = writeTranscript(dir, "a.jsonl", [
			{ type: "session", version: 3, id: "session-abc" },
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "read" },
						{ type: "toolCall", id: "call-2", name: "grep" },
					],
				},
			},
			{
				type: "message",
				id: "e2",
				message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
			},
		]);
		const ledger = readCallLedger(file);
		assert.equal(ledger.sessionId, "session-abc");
		assert.equal(ledger.calls.length, 2);
		assert.equal(ledger.calls[0].settled, true);
		assert.equal(ledger.calls[1].settled, false);
		assert.equal(unsettledCalls(ledger).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a call id that no result names stays unsettled", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-1", "run-1", "tool", "bash", "call-1", null, "turn 1", "transcript", 1000);
		settleByCallId(db, "run-1", "call-2", "a result of another call", 1001);
		assert.ok(findByCallId(db, "run-1", "call-1"));
		assert.equal(outstandingExecutions(db, "run-1").length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

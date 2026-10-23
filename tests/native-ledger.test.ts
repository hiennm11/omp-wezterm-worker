/**
 * The execution ledger of a native run.
 *
 * A native call opens a row when the call starts. A settled call and a failed
 * call settle the row of the same call. The report tool opens no row, because
 * the report file is its own evidence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { executionsOfRun } from "../extensions/lib/executions.ts";
import { observeNative, recordNativeCall } from "../extensions/lib/native-ledger.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { freshDb } from "./execution-helpers.ts";

/** One observation of a native program. */
function observation(source: string, payload: unknown) {
	return {
		backend: "claude",
		runId: "run-1",
		sessionId: "session-1",
		source,
		payload,
	};
}

test("an opened native call opens one row", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("tool.call.opened", { callId: "call-1", tool: "bash" }), 1000);
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].id, "ex-run-1-call-1");
		assert.equal(rows[0].kind, "tool");
		assert.equal(rows[0].toolName, "bash");
		assert.equal(rows[0].callId, "call-1");
		assert.equal(rows[0].startEvidence, "tool.call.opened");
		assert.equal(rows[0].observation, "bridge");
		assert.equal(rows[0].state, "open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a settled native call settles the row of the same call", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("tool.call.opened", { callId: "call-1", tool: "bash" }), 1000);
		recordNativeCall(db, "run-1", observation("tool.call.settled", { callId: "call-1", tool: "bash" }), 1100);
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "tool result");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed native call settles the row of the same call", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("tool.call.opened", { callId: "call-1", tool: "bash" }), 1000);
		recordNativeCall(db, "run-1", observation("tool.call.failed", { callId: "call-1", tool: "bash" }), 1100);
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "tool call failed");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a native call without a call id opens no row", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("tool.call.opened", { tool: "bash" }), 1000);
		assert.equal(executionsOfRun(db, "run-1").length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a native call to the report tool opens no row", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("tool.call.opened", { callId: "call-1", tool: "wezterm_worker_report" }), 1000);
		recordNativeCall(
			db,
			"run-1",
			observation("tool.call.opened", { callId: "call-2", tool: "mcp__wezterm-worker__wezterm_worker_report" }),
			1000,
		);
		assert.equal(executionsOfRun(db, "run-1").length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a native settlement without a row creates no row", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("tool.call.settled", { callId: "call-1", tool: "bash" }), 1000);
		recordNativeCall(db, "run-1", observation("tool.call.failed", { callId: "call-2", tool: "bash" }), 1000);
		assert.equal(executionsOfRun(db, "run-1").length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("another observation of a native run changes no row", () => {
	const { db, dir } = freshDb();
	try {
		recordNativeCall(db, "run-1", observation("turn.start", { turnId: "turn-1" }), 1000);
		recordNativeCall(db, "run-1", observation("background.settled", { uuid: "row-1" }), 1000);
		recordNativeCall(db, "run-1", observation("tool.check", { callId: "call-1", decision: "ask" }), 1000);
		assert.equal(executionsOfRun(db, "run-1").length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("observing a native call updates the state and writes the row", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-nativeledger-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const state = createClaudeRunState("run-1");
		observeNative(rt, state, "run-1", observation("tool.call.opened", { callId: "call-1", tool: "bash" }));
		assert.equal(state.openCalls.size, 1);
		const rows = executionsOfRun(rt.openDb(), "run-1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].callId, "call-1");
		assert.equal(rows[0].state, "open");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a database error of a native observation does not reach the bridge", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-nativeledger-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		/* A file in the path of the state directory makes the database open
		   fail. The observation must survive it. */
		const blocker = join(stateDir, "blocker");
		writeFileSync(blocker, "not a directory");
		rt.config.stateDir = join(blocker, "state");
		const state = createClaudeRunState("run-1");
		observeNative(rt, state, "run-1", observation("tool.call.opened", { callId: "call-1", tool: "bash" }));
		assert.equal(rt.errors.length, 1);
		assert.equal(state.openCalls.size, 1);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

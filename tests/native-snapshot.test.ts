/**
 * The run snapshot of a native worker.
 *
 * A restart loses the memory of a native run. The worker sends a run
 * snapshot to the new owner. The snapshot names the cycle of the run, the
 * instruction that waits, the calls that run and the permission requests that
 * wait.
 *
 * The new owner settles the open rows of kind tool that the snapshot does not
 * hold. A row of kind background stays open.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import {
	applyObservation,
	claudeBoundReport,
	claudeCompletionBlocker,
	createClaudeRunState,
} from "../extensions/lib/claude-run-state.ts";
import { executionsOfRun, openExecution } from "../extensions/lib/executions.ts";
import { recordNativeCall } from "../extensions/lib/native-ledger.ts";
import { reattachNative } from "../extensions/lib/reattach-native.ts";
import { freshDb } from "./execution-helpers.ts";
import {
	cleanup,
	fakeRuntime,
	makeDirs,
	nativeJob,
	postObservation,
} from "./reattach-native-helpers.ts";

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

/** A snapshot of a run that holds one closed cycle. */
function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		takenAt: 2000,
		deliveredCycleId: "turn-1",
		turnOpen: false,
		pendingInstructionId: null,
		openCalls: [],
		pendingApprovals: [],
		...overrides,
	};
}

test("a report of the cycle of the snapshot binds after the snapshot", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(
		state,
		observation("report", { cycleId: "turn-1", state: "completed", result: "THE-ANSWER" }),
	);
	assert.equal(claudeBoundReport(state), null, "the report binds to no cycle before the snapshot");
	applyObservation(state, observation("state.snapshot", snapshot()));
	assert.equal(claudeBoundReport(state)?.result, "THE-ANSWER", "the snapshot binds the report");
});

test("a second snapshot is valid and holds the newer state", () => {
	const state = createClaudeRunState("run-1");
	assert.equal(applyObservation(state, observation("state.snapshot", snapshot())), true);
	assert.equal(
		applyObservation(state, observation("state.snapshot", snapshot({ takenAt: 3000 }))),
		true,
	);
	assert.equal(state.snapshotAt, 3000, "the newer snapshot holds the time");
});

test("a snapshot of a closed turn lets the run finish", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("state.snapshot", snapshot({ turnOpen: false })));
	assert.equal(state.currentCycleId, "turn-1", "the snapshot names the cycle");
	assert.equal(state.completedTurns.has("turn-1"), true, "the closed turn ended");
	assert.equal(claudeCompletionBlocker(state), null, "the closed turn blocks nothing");
});

test("a snapshot of an open turn blocks the run until the turn ends", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("state.snapshot", snapshot({ turnOpen: true })));
	assert.ok(
		(claudeCompletionBlocker(state) ?? "").includes("turn"),
		"the open turn blocks the completion",
	);
	applyObservation(state, observation("turn.complete", { turnId: "turn-1", usage: null }));
	assert.equal(claudeCompletionBlocker(state), null, "the end of the turn clears the blocker");
});

test("a pending instruction of the snapshot blocks the run until it is delivered", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(
		state,
		observation("state.snapshot", snapshot({ pendingInstructionId: "inst-1" })),
	);
	assert.ok(
		(claudeCompletionBlocker(state) ?? "").includes("instruction"),
		"the pending instruction blocks the completion",
	);
	applyObservation(state, observation("instruction.delivered", { instructionId: "inst-1" }));
	assert.equal(claudeCompletionBlocker(state), null, "the delivery of the instruction clears it");
});

test("the calls and the permission requests of the snapshot become the open ones", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(
		state,
		observation(
			"state.snapshot",
			snapshot({
				openCalls: [["call-1", "Bash"]],
				pendingApprovals: [["call-2", "Write"]],
			}),
		),
	);
	assert.equal(state.openCalls.get("call-1"), "Bash", "the call of the snapshot stays open");
	assert.equal(state.openApprovals.get("call-2"), "Write", "the request of the snapshot waits");
	assert.ok(
		(claudeCompletionBlocker(state) ?? "").includes("permission"),
		"the open request blocks the completion",
	);
});

test("an open tool row that the snapshot does not hold becomes settled", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-1", "run-1", "tool", "Bash", "call-1", null, "opened", "bridge", 1000);
		recordNativeCall(db, "run-1", observation("state.snapshot", snapshot()), 3000);
		const row = executionsOfRun(db, "run-1")[0];
		assert.equal(row.state, "settled", "the row settles without the snapshot");
		assert.equal(row.settlementEvidence, "call not open in the snapshot of the worker");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a tool row that the snapshot holds stays open", () => {
	const { db, dir } = freshDb();
	try {
		const state = createClaudeRunState("run-1");
		openExecution(db, "ex-1", "run-1", "tool", "Bash", "call-1", null, "opened", "bridge", 1000);
		const snap = snapshot({ openCalls: [["call-1", "Bash"]] });
		applyObservation(state, observation("state.snapshot", snap));
		recordNativeCall(db, "run-1", observation("state.snapshot", snap), 3000);
		assert.equal(state.openCalls.get("call-1"), "Bash", "the snapshot holds the call");
		assert.equal(executionsOfRun(db, "run-1")[0].state, "open", "the row of the call stays open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a tool row that the worker created after the snapshot stays open", () => {
	const { db, dir } = freshDb();
	try {
		openExecution(db, "ex-old", "run-1", "tool", "Bash", "call-old", null, "opened", "bridge", 1500);
		openExecution(db, "ex-at", "run-1", "tool", "Bash", "call-at", null, "opened", "bridge", 2000);
		openExecution(db, "ex-new", "run-1", "tool", "Bash", "call-new", null, "opened", "bridge", 2500);
		recordNativeCall(db, "run-1", observation("state.snapshot", snapshot()), 3000);
		const rows = executionsOfRun(db, "run-1");
		assert.equal(rows[0].state, "settled", "the old row settles");
		assert.equal(rows[1].state, "open", "the row of the snapshot time stays open");
		assert.equal(rows[2].state, "open", "the row after the snapshot stays open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a background row stays open even when the snapshot does not hold it", () => {
	const { db, dir } = freshDb();
	try {
		const state = createClaudeRunState("run-1");
		openExecution(
			db,
			"ex-1",
			"run-1",
			"background",
			"Bash",
			"call-1",
			"job-1",
			"opened",
			"bridge",
			1000,
		);
		const snap = snapshot();
		applyObservation(state, observation("state.snapshot", snap));
		recordNativeCall(db, "run-1", observation("state.snapshot", snap), 3000);
		assert.equal(state.currentCycleId, "turn-1", "the snapshot reached the state");
		assert.equal(executionsOfRun(db, "run-1")[0].state, "open", "the task row stays open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a new owner binds the report of a snapshot run and settles the old row", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		openExecution(rt.openDb(), "ex-old", job.id, "tool", "Bash", "call-old", null, "opened", "bridge", 1000);
		await reattachNative(rt, job);
		const bridge = rt.bridges.get(job.id);
		assert.ok(bridge, "the new owner holds a bridge");

		const accepted = await postObservation(bridge.baseUrl, bridge.token, "state.snapshot", {
			takenAt: 2000,
			deliveredCycleId: "turn-1",
			turnOpen: false,
			pendingInstructionId: null,
			openCalls: [],
			pendingApprovals: [],
		});
		assert.equal(accepted, 202, "the bridge takes the snapshot");
		await postObservation(bridge.baseUrl, bridge.token, "report", {
			cycleId: "turn-1",
			state: "completed",
			result: "THE-ANSWER",
		});

		const state = rt.claudeStates.get(job.id);
		assert.ok(state, "the new owner holds a state");
		assert.equal(state.currentCycleId, "turn-1", "the snapshot names the cycle");
		assert.equal(claudeBoundReport(state)?.result, "THE-ANSWER", "the report binds to the cycle");
		const rows = executionsOfRun(rt.openDb(), job.id);
		assert.equal(rows.length, 1, "the run holds one row");
		assert.equal(rows[0].state, "settled", "the snapshot settles the row of the old owner");
	} finally {
		await cleanup(rt, dir);
	}
});

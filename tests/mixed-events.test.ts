/**
 * The stable events of three backends in one database.
 *
 * The extension raises an event for a worker of each backend in one state
 * directory. The three events have three different ids, and every id names
 * its own run. The status tool lists the three events as pending. The
 * acknowledgement of one event leaves the other two pending. A second
 * acknowledgement with another disposition is refused. The events keep their
 * ids after a new host opens the same state directory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyObservation } from "../extensions/lib/claude-run-state.ts";
import { pendingEvents, readEvent } from "../extensions/lib/events.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";

import {
	type MixedMachine,
	mixedMachine,
	replyText,
	TASK,
	toolCtx,
	toolOf,
	writeOpenCallTranscript,
} from "./mixed-helpers.ts";

/**
 * Start one worker of each backend and raise one event for it.
 *
 * The event of a native worker comes from the observation of the bridge, so
 * the monitor of the worker raises it. The event of the OMP worker comes from
 * the ledger of the run, so a worker that stops with an open call raises it.
 */
async function raiseEventsOfThreeBackends(machine: MixedMachine) {
	const spawn = toolOf(machine.rt, registerSpawnTool, "spawn");
	const ctx = toolCtx(machine.dir, "session-mixed");
	for (const backend of ["omp", "claude", "codex"]) {
		const started = await spawn.execute("t1", { task: TASK, cwd: machine.dir, backend }, ctx);
		assert.equal(started.isError, undefined, `the ${backend} worker did not start`);
	}

	/* The person answers a call of a native worker in its pane. The
	   observation of the bridge opens the approval of the worker. */
	for (const job of machine.rt.jobs.values()) {
		const state = machine.rt.claudeStates.get(job.id);
		if (!state) continue;
		applyObservation(state, {
			backend: job.backend ?? "claude",
			runId: job.id,
			sessionId: null,
			source: "tool.check",
			payload: { callId: `call-${job.id}`, tool: "Bash", decision: "ask" },
		});
	}
	machine.timers.tick();

	/* The OMP worker holds a call that never settles. The ledger of the run
	   names the loss when the worker stops. */
	const omp = [...machine.rt.jobs.values()].find((job) => !job.backend);
	assert.ok(omp, "the runtime holds no OMP worker");
	writeOpenCallTranscript(omp);
	machine.timers.tick();
	await finalizeJob(machine.rt, omp, "failed", "the worker stopped", null);
}

test("the events of three backends have three ids that name their own run", async () => {
	const machine = mixedMachine();
	try {
		await raiseEventsOfThreeBackends(machine);
		const events = pendingEvents(machine.rt.openDb()).filter((event) => event.condition !== "result");
		assert.equal(events.length, 3, "the database holds no three events");
		const ids = events.map((event) => event.id);
		assert.equal(new Set(ids).size, 3, "the events do not have three different ids");
		const runIds = events.map((event) => event.runId);
		assert.equal(new Set(runIds).size, 3, "the events do not name three runs");

		/* The key of an event joins the run, the evidence and the condition.
		   The key of the event of a run names that run, so a second run with
		   the same evidence does not find the event of the first run. */
		const keys = (
			machine.rt.openDb().handle.prepare("SELECT key FROM meta WHERE key LIKE 'event_key:%'").all() as {
				key: string;
			}[]
		).filter((row) => !row.key.endsWith("|result"));
		assert.equal(keys.length, 3, "the database holds no three keys");
		for (const key of keys.map((row) => row.key)) {
			const runId = key.slice("event_key:".length).split("|")[0];
			assert.ok(runIds.includes(runId), `the key ${key} names no run of the test`);
		}
	} finally {
		await machine.cleanup();
	}
});

test("the status tool lists the three events of the three backends as pending", async () => {
	const machine = mixedMachine();
	try {
		await raiseEventsOfThreeBackends(machine);
		const status = toolOf(machine.rt, registerStatusTool, "status");
		const listed = await status.execute("t1", {});
		const text = replyText(listed);
		assert.match(text, /Events that wait for you/, "the status tool lists no pending event");
		for (const event of pendingEvents(machine.rt.openDb())) {
			assert.match(text, new RegExp(event.id), `the status tool does not list ${event.id}`);
		}
	} finally {
		await machine.cleanup();
	}
});

test("the acknowledgement of one event leaves the other two pending", async () => {
	const machine = mixedMachine();
	try {
		await raiseEventsOfThreeBackends(machine);
		const events = pendingEvents(machine.rt.openDb());
		const event = events[0];
		assert.ok(event, "the database holds no event of a worker");

		const ack = toolOf(machine.rt, registerAckTool, "ack");
		const answered = await ack.execute("t1", {
			workerId: event.runId,
			eventId: event.id,
			disposition: "accepted",
		});
		assert.equal(answered.details.acknowledged, true, "the acknowledgement of the worker failed");

		const pending = pendingEvents(machine.rt.openDb())
			.map((entry) => entry.id)
			.sort();
		const expected = events
			.map((entry) => entry.id)
			.filter((id) => id !== event.id)
			.sort();
		assert.deepEqual(pending, expected, "the acknowledgement closed another event");
	} finally {
		await machine.cleanup();
	}
});

test("a second acknowledgement with another disposition is refused", async () => {
	const machine = mixedMachine();
	try {
		await raiseEventsOfThreeBackends(machine);
		const events = pendingEvents(machine.rt.openDb());
		const event = events[0];
		assert.ok(event, "the database holds no event of a worker");

		const ack = toolOf(machine.rt, registerAckTool, "ack");
		const first = await ack.execute("t1", {
			workerId: event.runId,
			eventId: event.id,
			disposition: "accepted",
		});
		assert.equal(first.details.acknowledged, true, "the first acknowledgement failed");

		const second = await ack.execute("t2", {
			workerId: event.runId,
			eventId: event.id,
			disposition: "discarded",
		});
		assert.equal(second.details.acknowledged, false, "the second acknowledgement was accepted");
		assert.match(
			replyText(second),
			/already handled as accepted/,
			"the refusal does not name the first disposition",
		);
	} finally {
		await machine.cleanup();
	}
});

test("the events keep their ids after a new host opens the same state directory", async () => {
	const machine = mixedMachine();
	try {
		await raiseEventsOfThreeBackends(machine);
		const before = pendingEvents(machine.rt.openDb())
			.map((event) => event.id)
			.sort();

		const second = machine.newHost({ stateDir: machine.dir, sessionId: "session-mixed" });
		try {
			const events = pendingEvents(second.rt.openDb());
			const after = events.map((event) => event.id).sort();
			assert.deepEqual(after, before, "the new host holds other events");
			for (const event of events) {
				assert.equal(
					readEvent(second.rt.openDb(), event.id)?.runId,
					event.runId,
					"the event names another run",
				);
			}
		} finally {
			await second.cleanup();
		}
	} finally {
		await machine.cleanup();
	}
});

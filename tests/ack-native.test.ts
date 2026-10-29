/**
 * The acknowledgement of an event of a native run.
 *
 * A native run is a Claude Code run. Its job has the backend `claude` and a
 * native session id. The owner acknowledges the events of such a run with
 * the ack tool, and the status tool stops listing the event afterwards.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pendingEvents } from "../extensions/lib/events.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import {
	finish,
	handlingRows,
	nativeJob,
	nativeRuntime,
	seedOwner,
	seedPermissionEvent,
	toolOf,
} from "./native-run-helpers.ts";

/** The session that calls the tool. */
const OWN = "session-1";

/** The session that holds the task. */
const OTHER = "session-old";

test("the owner acknowledges the event of a native run", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		seedPermissionEvent(rt, job.id, "ev-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: "wz-1",
			eventId: "ev-1",
			disposition: "accepted",
		});

		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /is handled as accepted/);
		assert.equal(result.details.acknowledged, true);
		assert.deepEqual(
			pendingEvents(rt.openDb()).map((event) => event.id),
			[],
			"the event leaves the pending events",
		);
	} finally {
		finish(rt, dir);
	}
});

test("a second acknowledgement of the same event has no second effect", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		seedPermissionEvent(rt, job.id, "ev-1");
		const tool = toolOf(rt, registerAckTool, "ack");

		const first = await tool.execute("t1", {
			workerId: "wz-1",
			eventId: "ev-1",
			disposition: "accepted",
		});
		const second = await tool.execute("t2", {
			workerId: "wz-1",
			eventId: "ev-1",
			disposition: "accepted",
		});

		assert.notEqual(first.isError, true);
		assert.notEqual(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /is handled as accepted/);
		assert.equal(handlingRows(rt, "ev-1"), 1, "the handling holds one row");

		const other = await tool.execute("t3", {
			workerId: "wz-1",
			eventId: "ev-1",
			disposition: "discarded",
		});

		assert.equal(other.isError, true);
		assert.equal(other.content[0]?.text, "The event was already handled as accepted.");
		assert.equal(other.details.acknowledged, false);
		assert.equal(handlingRows(rt, "ev-1"), 1, "the handling still holds one row");
	} finally {
		finish(rt, dir);
	}
});

test("a session that does not own the native task cannot acknowledge its event", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OTHER);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		seedPermissionEvent(rt, job.id, "ev-1");

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: "wz-1",
			eventId: "ev-1",
			disposition: "accepted",
		});

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
		);
		assert.equal(result.details.acknowledged, false);
		assert.deepEqual(
			pendingEvents(rt.openDb()).map((event) => event.id),
			["ev-1"],
			"the event stays pending",
		);
		assert.equal(handlingRows(rt, "ev-1"), 0);
	} finally {
		finish(rt, dir);
	}
});

test("an unknown event id is refused", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt, registerAckTool, "ack").execute("t1", {
			workerId: "wz-1",
			eventId: "ev-unknown",
			disposition: "accepted",
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown event id/);
		assert.equal(result.details.acknowledged, false);
	} finally {
		finish(rt, dir);
	}
});

test("the status tool stops listing the event of a native run after the acknowledgement", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		seedPermissionEvent(rt, job.id, "ev-1");
		const status = toolOf(rt, registerStatusTool, "status");

		const before = await status.execute("t1", {});
		assert.match(before.content[0]?.text ?? "", /Events that wait for you/);
		assert.match(before.content[0]?.text ?? "", /ev-1/);

		await toolOf(rt, registerAckTool, "ack").execute("t2", {
			workerId: "wz-1",
			eventId: "ev-1",
			disposition: "accepted",
		});

		const after = await status.execute("t3", {});
		assert.doesNotMatch(after.content[0]?.text ?? "", /Events that wait for you/);
		assert.doesNotMatch(after.content[0]?.text ?? "", /ev-1/);
		assert.deepEqual(after.details.events, []);
	} finally {
		finish(rt, dir);
	}
});

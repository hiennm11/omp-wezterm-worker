/**
 * The decision that a closing session releases its running tasks.
 *
 * The decision is a pure function, so the test needs no pane and no
 * database. It proves which rows a closing session gives away and which rows
 * it leaves alone.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	belongsToThisProcess,
	type ReleaseOwner,
	type ReleaseOwners,
	releaseableJobIds,
} from "../extensions/lib/session-release.ts";

/** The session that owns the tasks of the test. */
const SESSION = "session-a";

/** Another session. */
const OTHER_SESSION = "session-b";

/** The process id of this process. */
const PROCESS = 500;

/** The start time of this process. */
const START = "2026-11-05T01:00:00.000Z";

/** The start time of another process. */
const OTHER_START = "2026-11-04T01:00:00.000Z";

function owner(overrides: Partial<ReleaseOwner> = {}): ReleaseOwner {
	return {
		sessionId: SESSION,
		processId: PROCESS,
		processStartedAt: START,
		phase: "active",
		...overrides,
	};
}

test("a running job of this process is released", () => {
	const owners: ReleaseOwners = { "wz-1": owner() };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "running" }], SESSION, PROCESS, START);
	assert.deepEqual(released, ["wz-1"]);
});

test("a queued job of this process is released", () => {
	const owners: ReleaseOwners = { "wz-1": owner() };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "queued" }], SESSION, PROCESS, START);
	assert.deepEqual(released, ["wz-1"]);
});

test("a row of an ended run stays as it is", () => {
	const owners: ReleaseOwners = { "wz-1": owner() };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "completed" }], SESSION, PROCESS, START);
	assert.deepEqual(released, []);
});

test("a row of another session stays as it is", () => {
	const owners: ReleaseOwners = { "wz-1": owner({ sessionId: OTHER_SESSION }) };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "running" }], SESSION, PROCESS, START);
	assert.deepEqual(released, []);
});

test("a row of another process stays as it is", () => {
	const owners: ReleaseOwners = { "wz-1": owner({ processId: 900 }) };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "running" }], SESSION, PROCESS, START);
	assert.deepEqual(released, []);
});

test("a row of another incarnation of this process stays as it is", () => {
	const owners: ReleaseOwners = { "wz-1": owner({ processStartedAt: OTHER_START }) };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "running" }], SESSION, PROCESS, START);
	assert.deepEqual(released, []);
});

test("a row that is not active stays as it is", () => {
	const owners: ReleaseOwners = { "wz-1": owner({ phase: "released" }) };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "running" }], SESSION, PROCESS, START);
	assert.deepEqual(released, []);
});

test("a job without an ownership row stays as it is", () => {
	const released = releaseableJobIds({}, [{ id: "wz-1", status: "running" }], SESSION, PROCESS, START);
	assert.deepEqual(released, []);
});

test("a session without an identity releases nothing", () => {
	const owners: ReleaseOwners = { "wz-1": owner() };
	const released = releaseableJobIds(owners, [{ id: "wz-1", status: "running" }], null, PROCESS, START);
	assert.deepEqual(released, []);
});

test("the row of this process belongs to this process", () => {
	assert.equal(belongsToThisProcess(owner(), SESSION, PROCESS, START), true);
	assert.equal(belongsToThisProcess(owner({ sessionId: OTHER_SESSION }), SESSION, PROCESS, START), false);
	assert.equal(belongsToThisProcess(owner({ processId: 900 }), SESSION, PROCESS, START), false);
	assert.equal(
		belongsToThisProcess(owner({ processStartedAt: OTHER_START }), SESSION, PROCESS, START),
		false,
	);
	assert.equal(belongsToThisProcess(owner({ phase: "releasing" }), SESSION, PROCESS, START), false);
});

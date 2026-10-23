/**
 * The authority rules of the tools that control a worker.
 *
 * The rules are pure functions. A test checks them without a pane, without a
 * database and without a session.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanupRefusal, controlRefusal, refusalDetails } from "../extensions/lib/authority.ts";
import type { OwnerPhase, Ownership } from "../extensions/lib/ownership.ts";

/** The session that owns the task. */
const OWN = "session-new";

/** The session that holds no authority. */
const OTHER = "session-old";

/** An ownership row of a task. */
function row(sessionId: string, phase: OwnerPhase): Ownership {
	return {
		taskKey: "task-wz-1",
		sessionId,
		processId: 100,
		processStartedAt: "2026-10-23T01:00:00.000Z",
		generation: 1,
		phase,
		updatedAt: 1000,
	};
}

/** One case of the rule table. */
interface Case {
	/** The name of the case. */
	name: string;
	/** The ownership row of the task, or null when the task has no row. */
	owner: Ownership | null;
	/** The identity of the calling session, or null when it has none. */
	sessionId: string | null;
	/** The text that the control rule gives, or null when it allows the action. */
	control: string | null;
	/** The text that the cleanup rule gives, or null when it allows the action. */
	cleanup: string | null;
}

/** The cases of the rule table. */
const CASES: Case[] = [
	{
		name: "a task without an ownership row",
		owner: null,
		sessionId: OWN,
		control: null,
		cleanup: null,
	},
	{
		name: "a session without an identity",
		owner: row(OTHER, "active"),
		sessionId: null,
		control: null,
		cleanup: null,
	},
	{
		name: "the owner of an active task",
		owner: row(OWN, "active"),
		sessionId: OWN,
		control: null,
		cleanup: null,
	},
	{
		name: "the owner of a releasing task",
		owner: row(OWN, "releasing"),
		sessionId: OWN,
		control: "This session is releasing worker wz-1.",
		cleanup: null,
	},
	{
		name: "the owner of a released task",
		owner: row(OWN, "released"),
		sessionId: OWN,
		control: "This session released worker wz-1.",
		cleanup: null,
	},
	{
		name: "another session of an active task",
		owner: row(OTHER, "active"),
		sessionId: OWN,
		control: "Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
		cleanup: "Worker wz-1 belongs to session session-old (phase active). This session only reads it.",
	},
	{
		name: "another session of a releasing task",
		owner: row(OTHER, "releasing"),
		sessionId: OWN,
		control: "Worker wz-1 belongs to session session-old (phase releasing). This session only reads it.",
		cleanup: "Worker wz-1 belongs to session session-old (phase releasing). This session only reads it.",
	},
	{
		name: "another session of a released task",
		owner: row(OTHER, "released"),
		sessionId: OWN,
		control: "Worker wz-1 belongs to session session-old (phase released). This session only reads it.",
		cleanup: null,
	},
];

test("the control rule refuses the task of another session", () => {
	for (const item of CASES) {
		assert.equal(controlRefusal(item.owner, item.sessionId, "wz-1"), item.control, item.name);
	}
});

test("the cleanup rule refuses the task that another session holds", () => {
	for (const item of CASES) {
		assert.equal(cleanupRefusal(item.owner, item.sessionId, "wz-1"), item.cleanup, item.name);
	}
});

test("the details of a refusal name the worker and the owner", () => {
	assert.deepEqual(refusalDetails("wz-1", row(OTHER, "active")), {
		workerId: "wz-1",
		owner: OTHER,
		phase: "active",
	});
});

test("the details of a refusal without a row hold no owner and no phase", () => {
	assert.deepEqual(refusalDetails("wz-1", null), { workerId: "wz-1", owner: null, phase: null });
});

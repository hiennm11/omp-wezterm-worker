/**
 * The recovery of a resource group whose holder ended with a pane that the
 * user closed by hand.
 *
 * The startup recovery reads the pane list one time. It frees a group whose
 * holder ended and whose pane is gone. An open pane and an unreadable pane
 * list keep the group held.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { groupsToRelease, releaseEndedGroups } from "../extensions/lib/group-recovery.ts";
import { type ResourceGroup, readGroup } from "../extensions/lib/groups.ts";
import type { Job } from "../extensions/lib/job.ts";
import type { PaneState } from "../extensions/lib/pane.ts";
import { fakeWezterm, heldGroup, jobOf, runtimeFor } from "./group-holder-helpers.ts";

/** A holder that ended and whose pane the user closed by hand. */
function endedHolder(id: string, paneId: number): Job {
	return jobOf(id, { paneId, paneClosed: false, status: "completed" });
}

test("the recovery frees the group of a holder whose pane is gone", async (t) => {
	const { exec } = fakeWezterm({ panes: [{ pane_id: 99, tab_id: 1, window_id: 1 }] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = endedHolder("wz-1", 121);
	const group = heldGroup(rt, db, job);

	const freed = await releaseEndedGroups(rt, [job], 1002);

	assert.deepEqual(freed, [group.id]);
	assert.equal(readGroup(db, group.id)?.executionHolder, null);
	assert.equal(readGroup(db, group.id)?.executionState, "free");
	assert.equal(job.paneClosed, true);
});

test("the recovery keeps the group of a holder whose pane is open", async (t) => {
	const { exec } = fakeWezterm({ panes: [{ pane_id: 121, tab_id: 1, window_id: 1 }] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = endedHolder("wz-1", 121);
	const group = heldGroup(rt, db, job);

	const freed = await releaseEndedGroups(rt, [job], 1002);

	assert.deepEqual(freed, []);
	assert.equal(readGroup(db, group.id)?.executionHolder, "wz-1");
	assert.equal(job.paneClosed, false);
});

test("the recovery keeps the group of a holder when the pane list fails", async (t) => {
	const { exec } = fakeWezterm({ panes: [], listCode: 1 });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = endedHolder("wz-1", 121);
	const group = heldGroup(rt, db, job);

	const freed = await releaseEndedGroups(rt, [job], 1002);

	assert.deepEqual(freed, []);
	assert.equal(readGroup(db, group.id)?.executionHolder, "wz-1");
	assert.equal(job.paneClosed, false);
});

test("the recovery frees the group of a holder whose pane is closed without a pane list", async (t) => {
	const { exec, calls } = fakeWezterm({ panes: [], listCode: 1 });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = jobOf("wz-1", { paneId: 121, paneClosed: true, status: "completed" });
	const group = heldGroup(rt, db, job);

	const freed = await releaseEndedGroups(rt, [job], 1002);

	assert.deepEqual(freed, [group.id]);
	assert.equal(readGroup(db, group.id)?.executionState, "free");
	assert.equal(calls.filter((args) => args.includes("list")).length, 0);
});

test("the recovery reads the pane list one time for two groups", async (t) => {
	const { exec, calls } = fakeWezterm({ panes: [] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const first = endedHolder("wz-1", 121);
	const second = endedHolder("wz-2", 122);
	const firstGroup = heldGroup(rt, db, first);
	const secondGroup = heldGroup(rt, db, second);

	const freed = await releaseEndedGroups(rt, [first, second], 1002);

	assert.deepEqual(freed.sort(), [firstGroup.id, secondGroup.id].sort());
	assert.equal(calls.filter((args) => args.includes("list")).length, 1);
});

test("the recovery reads no pane list when no ended holder has an open pane", async (t) => {
	const { exec, calls } = fakeWezterm({ panes: [] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = jobOf("wz-1", { paneId: null, paneClosed: false, status: "completed" });
	const group = heldGroup(rt, db, job);

	const freed = await releaseEndedGroups(rt, [job], 1002);

	assert.deepEqual(freed, [group.id]);
	assert.equal(calls.filter((args) => args.includes("list")).length, 0);
});

test("the recovery keeps the group of an active holder and of an unknown holder", async (t) => {
	const { exec } = fakeWezterm({ panes: [] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const active = jobOf("wz-1", { paneId: 121, paneClosed: false, status: "running" });
	const activeGroup = heldGroup(rt, db, active);
	const unknown = endedHolder("wz-2", 122);
	const unknownGroup = heldGroup(rt, db, unknown);
	rt.jobs.delete(unknown.id);

	const freed = await releaseEndedGroups(rt, [active], 1002);

	assert.deepEqual(freed, []);
	assert.equal(readGroup(db, activeGroup.id)?.executionHolder, "wz-1");
	assert.equal(readGroup(db, unknownGroup.id)?.executionHolder, "wz-2");
});

test("the decision of the recovery names one result for every state of the pane", () => {
	const groups: ResourceGroup[] = [
		{
			id: "grp-1",
			sessionDir: "C:/state/sessions/wz-1",
			worktreePath: null,
			worktreeOrigin: null,
			worktreeBranch: null,
			executionHolder: "wz-1",
			executionState: "held",
			disposing: false,
			updatedAt: 1000,
		},
	];
	const job = endedHolder("wz-1", 121);
	const cases: { state: PaneState | null; released: string[] }[] = [
		{ state: "gone", released: ["grp-1"] },
		{ state: "present", released: [] },
		{ state: "unknown", released: [] },
		{ state: null, released: [] },
	];

	for (const row of cases) {
		const states = new Map<number, PaneState>();
		if (row.state !== null) states.set(121, row.state);
		assert.deepEqual(
			groupsToRelease(groups, [job], states).map((group) => group.id),
			row.released,
			`the state ${row.state} must free the groups ${row.released.join(",")}`,
		);
	}
});

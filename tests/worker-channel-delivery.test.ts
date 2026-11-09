/**
 * The channel in the delivery and in the status.
 *
 * A delivery of a finished worker carries the newest worker notes. The
 * status shows the count of the notes of each side and no note text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { newestNotes, selectNotes } from "../extensions/lib/channel-select.ts";
import { readChannelNotes } from "../extensions/lib/channel-store.ts";
import { formatDelivery } from "../extensions/lib/deliver.ts";
import { usageReport } from "../extensions/lib/usage.ts";
import { registerNoteToMainTool } from "../extensions/worker-tools/note-to-main.ts";
import { registerNoteToWorkerTool } from "../extensions/worker-tools/note-to-worker.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { makeJob } from "./takeover-helpers.ts";
import {
	asWorker,
	type FakeTool,
	fakeRuntime,
	fakeZod,
	finish,
	mainToolOf,
	OWN,
	seedOwner,
	workerSession,
	workerToolOf,
} from "./worker-channel-helpers.ts";

test("the delivery of a finished worker carries at most 10 notes", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		const write = workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main");
		for (let index = 1; index <= 13; index += 1) {
			await asWorker(sessionDir, () => write.execute(`t${index}`, { text: `note number ${index}` }));
		}

		const text = formatDelivery(
			{ ...job, status: "completed", result: "the answer" } as never,
			{ worker: usageReport(null, "x"), request: usageReport(null, "x") },
			0,
			false,
			undefined,
			readChannelNotes(sessionDir, "worker"),
		);
		const carried = text.match(/Note \d+: note number \d+/g) ?? [];
		assert.equal(carried.length, 10, "the delivery carries at most 10 notes");
		assert.match(text, /note number 13/);
		assert.doesNotMatch(text, /Note 1: note number 1\b/);
		assert.match(text, /3 older worker note\(s\) are not in this delivery/);
		assert.match(text, /wezterm_worker_notes_from_worker/);
	} finally {
		finish(rt, dir);
	}
});

test("the status shows the count of the notes of each side", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		const write = workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main");
		await asWorker(sessionDir, () => write.execute("t1", { text: "the first note" }));
		await asWorker(sessionDir, () => write.execute("t2", { text: "the second note" }));
		await mainToolOf(rt, registerNoteToWorkerTool, "wezterm_worker_note_to_worker").execute("t3", {
			workerId: job.id,
			text: "a note for the worker",
		});

		const tools = new Map<string, FakeTool>();
		registerStatusTool({
			pi: {
				zod: fakeZod(),
				registerTool: (tool: FakeTool) => tools.set("status", tool),
			} as never,
			rt,
			deliver: () => undefined,
		});
		const status = tools.get("status");
		assert.ok(status, "the status tool was not registered");
		const result = await status.execute("t4", {});
		const text = result.content[0]?.text ?? "";
		assert.match(text, /notes: 2 from worker, 1 to worker/);
		assert.doesNotMatch(text, /the first note/);
		assert.doesNotMatch(text, /a note for the worker/);
	} finally {
		finish(rt, dir);
	}
});

test("the selection of the notes is a pure function", () => {
	const notes = [
		{ seq: 1, runId: "wz-1", text: "one", at: 1 },
		{ seq: 2, runId: "wz-1", text: "two", at: 2 },
		{ seq: 3, runId: "wz-1", text: "three", at: 3 },
	];
	assert.deepEqual(
		selectNotes(notes, 0).notes.map((note) => note.seq),
		[1, 2, 3],
	);
	assert.deepEqual(
		selectNotes(notes, 2).notes.map((note) => note.seq),
		[3],
	);
	assert.equal(selectNotes(notes, 2).highestSeq, 3);
	assert.equal(selectNotes([], 0).highestSeq, 0);

	const newest = newestNotes(notes, 2);
	assert.deepEqual(
		newest.notes.map((note) => note.seq),
		[2, 3],
	);
	assert.equal(newest.older, 1);
});

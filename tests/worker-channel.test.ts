/**
 * The worker channel.
 *
 * The main session and a worker exchange short notes. A note changes no
 * state of the task. The tests prove the behaviours that a user can see.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeRunContext } from "../extensions/lib/worker-context.ts";
import extension from "../extensions/wezterm-worker.ts";
import { registerNoteToMainTool } from "../extensions/worker-tools/note-to-main.ts";
import { registerNoteToWorkerTool } from "../extensions/worker-tools/note-to-worker.ts";
import { registerNotesFromMainTool } from "../extensions/worker-tools/notes-from-main.ts";
import { registerNotesFromWorkerTool } from "../extensions/worker-tools/notes-from-worker.ts";
import { makeJob } from "./takeover-helpers.ts";
import {
	asWorker,
	fakeRuntime,
	fakeZod,
	finish,
	mainToolOf,
	OWN,
	seedOwner,
	workerSession,
	workerToolOf,
	type FakeTool,
} from "./worker-channel-helpers.ts";

test("a worker note reaches the main session", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);

		const written = await asWorker(sessionDir, () =>
			workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main").execute("t1", {
				text: "The build fails on Windows.",
			}),
		);
		assert.equal(written.isError, undefined);
		assert.match(written.content[0]?.text ?? "", /note is in the channel of the main session/);

		const read = await mainToolOf(
			rt,
			registerNotesFromWorkerTool,
			"wezterm_worker_notes_from_worker",
		).execute("t2", { workerId: job.id });
		assert.match(read.content[0]?.text ?? "", /The build fails on Windows\./);
		assert.equal(read.details.count, 1);
	} finally {
		finish(rt, dir);
	}
});

test("a main note reaches the worker", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);

		const written = await mainToolOf(rt, registerNoteToWorkerTool, "wezterm_worker_note_to_worker").execute(
			"t1",
			{ workerId: job.id, text: "Use the channel for the next fact." },
		);
		assert.equal(written.isError, undefined);
		assert.match(written.content[0]?.text ?? "", /channel of worker wz-1/);

		const read = await asWorker(sessionDir, () =>
			workerToolOf(rt, registerNotesFromMainTool, "wezterm_worker_notes_from_main").execute("t2", {}),
		);
		assert.match(read.content[0]?.text ?? "", /Use the channel for the next fact\./);
	} finally {
		finish(rt, dir);
	}
});

test("afterSeq returns only the newer notes", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		const write = workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main");

		const first = await asWorker(sessionDir, () => write.execute("t1", { text: "the first note" }));
		const firstSeq = Number(first.details.seq);
		const second = await asWorker(sessionDir, () => write.execute("t2", { text: "the second note" }));
		assert.equal(Number(second.details.seq), firstSeq + 1);

		const read = await mainToolOf(
			rt,
			registerNotesFromWorkerTool,
			"wezterm_worker_notes_from_worker",
		).execute("t3", { workerId: job.id, afterSeq: firstSeq });
		assert.equal(read.details.count, 1);
		assert.match(read.content[0]?.text ?? "", /the second note/);
		assert.doesNotMatch(read.content[0]?.text ?? "", /the first note/);
	} finally {
		finish(rt, dir);
	}
});

test("a foreign session cannot read or write the channel", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		workerSession(dir, job.id);
		rt.sessionId = "session-other";

		const written = await mainToolOf(rt, registerNoteToWorkerTool, "wezterm_worker_note_to_worker").execute(
			"t1",
			{ workerId: job.id, text: "a note of a foreign session" },
		);
		assert.equal(written.isError, true);
		assert.equal(
			written.content[0]?.text,
			"Worker wz-1 belongs to session session-new (phase active). This session only reads it.",
		);

		const read = await mainToolOf(
			rt,
			registerNotesFromWorkerTool,
			"wezterm_worker_notes_from_worker",
		).execute("t2", { workerId: job.id });
		assert.equal(read.isError, true);
		assert.equal(
			read.content[0]?.text,
			"Worker wz-1 belongs to session session-new (phase active). This session only reads it.",
		);
	} finally {
		finish(rt, dir);
	}
});

test("an over-long note and an empty note are refused", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		const write = workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main");

		const long = await asWorker(sessionDir, () => write.execute("t1", { text: "x".repeat(4001) }));
		assert.equal(long.isError, true);
		assert.match(long.content[0]?.text ?? "", /at most 4000 characters/);

		const empty = await asWorker(sessionDir, () => write.execute("t2", { text: "   " }));
		assert.equal(empty.isError, true);
		assert.match(empty.content[0]?.text ?? "", /needs text/);
	} finally {
		finish(rt, dir);
	}
});

test("a Claude worker and a Codex worker have no channel", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		for (const backend of ["claude", "codex"] as const) {
			const job = makeJob(dir, `wz-${backend}`, { backend });
			rt.jobs.set(job.id, job);
			seedOwner(rt, job.id, OWN);
			const sessionDir = workerSession(dir, job.id, backend);

			const written = await mainToolOf(rt, registerNoteToWorkerTool, "wezterm_worker_note_to_worker").execute(
				"t1",
				{ workerId: job.id, text: "a note for a native worker" },
			);
			assert.equal(written.isError, true);
			assert.match(written.content[0]?.text ?? "", /does not support the worker channel yet/);

			const read = await mainToolOf(
				rt,
				registerNotesFromWorkerTool,
				"wezterm_worker_notes_from_worker",
			).execute("t2", { workerId: job.id });
			assert.equal(read.isError, true);
			assert.match(read.content[0]?.text ?? "", /does not support the worker channel yet/);

			const workerNote = await asWorker(sessionDir, () =>
				workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main").execute("t3", {
					text: "a note of a native worker",
				}),
			);
			assert.equal(workerNote.isError, true);
			assert.match(workerNote.content[0]?.text ?? "", /does not support the worker channel yet/);
		}
	} finally {
		finish(rt, dir);
	}
});

test("the channel survives a resume", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		const write = workerToolOf(rt, registerNoteToMainTool, "wezterm_worker_note_to_main");
		await asWorker(sessionDir, () => write.execute("t1", { text: "a note before the resume" }));

		/* A resume shares the session directory of its source run, so the
		   channel of the task stays in the same place. */
		const resumed = { ...job, id: "wz-2", sessionDir };
		rt.jobs.set(resumed.id, resumed);
		seedOwner(rt, resumed.id, OWN);

		const read = await mainToolOf(
			rt,
			registerNotesFromWorkerTool,
			"wezterm_worker_notes_from_worker",
		).execute("t2", { workerId: resumed.id });
		assert.equal(read.details.count, 1);
		assert.match(read.content[0]?.text ?? "", /a note before the resume/);
	} finally {
		finish(rt, dir);
	}
});

test("a worker process gets the two channel tools", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wt-channel-worker-"));
	const sessionDir = join(cwd, "session");
	mkdirSync(sessionDir, { recursive: true });
	writeRunContext(sessionDir, { runId: "wz-1", sourceRunId: null, resourceGroup: "grp-wz-1" });
	const previous = process.env.OMP_WORKER_SESSION_DIR;
	process.env.OMP_WORKER_SESSION_DIR = sessionDir;
	try {
		const tools = new Map<string, FakeTool>();
		const pi = {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
			registerCommand: () => undefined,
			on: () => undefined,
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
			sendMessage: () => undefined,
		};
		extension(pi as never);
		assert.ok(tools.has("wezterm_worker_note_to_main"), "the worker did not get the note tool");
		assert.ok(tools.has("wezterm_worker_notes_from_main"), "the worker did not get the notes tool");
		assert.equal(
			tools.has("wezterm_worker_note_to_worker"),
			false,
			"a worker must not get the tools of the main session",
		);
	} finally {
		if (previous === undefined) delete process.env.OMP_WORKER_SESSION_DIR;
		else process.env.OMP_WORKER_SESSION_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
});

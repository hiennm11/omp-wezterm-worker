/**
 * The note channel of a Claude Code worker.
 *
 * The main session and a Claude Code worker exchange notes over the worker
 * channel. The mod of the worker reads the notes and writes them. The tests
 * prove the behaviours that a user can see.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendChannelNote, readChannelNotes } from "../extensions/lib/channel-store.ts";
import { startBridge } from "../extensions/lib/claude-bridge.ts";
import { startMod, toolResult } from "./claude-note-helpers.ts";

/** The names of the tools that the mod registers. */
const NOTE_TO_MAIN = "wezterm_worker_note_to_main";
const NOTES_FROM_MAIN = "wezterm_worker_notes_from_main";

/** The prefix that a delivered note carries. */
const PREFIX = "Note from the main session:";

/** The bridge of a test, with its session directory. */
interface Fixture {
	baseUrl: string;
	token: string;
	sessionDir: string;
	close: () => Promise<void>;
}

/** Start the bridge of a test and make a session directory. */
async function startFixture(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-note-"));
	const sessionDir = join(dir, "session");
	mkdirSync(sessionDir, { recursive: true });
	const bridge = await startBridge("wz-1", () => undefined, sessionDir);
	return {
		baseUrl: bridge.baseUrl,
		token: bridge.token,
		sessionDir,
		close: async () => {
			await bridge.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a request without the token of the bridge reads no note", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "The build fails on Windows.",
			at: Date.now(),
		});
		const response = await fetch(`${fixture.baseUrl}/channel/notes?runId=wz-1&afterSeq=0`, {
			headers: { authorization: "Bearer the-wrong-token" },
		});
		assert.equal(response.status, 401, "the bridge served a request with a wrong token");
		const body = await response.json();
		assert.equal(body.notes, undefined, "the bridge gave the notes to a wrong token");
	} finally {
		await fixture.close();
	}
});

test("a request for another run reads no note", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "The build fails on Windows.",
			at: Date.now(),
		});
		const response = await fetch(`${fixture.baseUrl}/channel/notes?runId=wz-2&afterSeq=0`, {
			headers: { authorization: `Bearer ${fixture.token}` },
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual(body.notes, [], "the bridge gave the notes of another run");
	} finally {
		await fixture.close();
	}
});

test("the mod registers the two channel tools of the worker", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const names = mod.tools().map((tool) => tool.name);
		assert.ok(names.includes(NOTE_TO_MAIN), "the mod registered no note tool");
		assert.ok(names.includes(NOTES_FROM_MAIN), "the mod registered no notes tool");
	} finally {
		await fixture.close();
	}
});

test("a pending note of the main session becomes exactly one prompt", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "The build fails on Windows.",
			at: Date.now(),
		});
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		await mod.poll();
		assert.equal(mod.submitted().length, 1, "the poll submitted no prompt");
		assert.equal(mod.submitted()[0], `${PREFIX} The build fails on Windows.`);
	} finally {
		await fixture.close();
	}
});

test("a second poll submits nothing for a note that was delivered", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "The build fails on Windows.",
			at: Date.now(),
		});
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		await mod.poll();
		await mod.poll();
		await mod.poll();
		assert.equal(mod.submitted().length, 1, "the poll submitted the note twice");
	} finally {
		await fixture.close();
	}
});

test("a restart of the session does not submit a delivered note again", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "The build fails on Windows.",
			at: Date.now(),
		});
		const store = new Map<string, string>();
		const first = await startMod(
			fixture,
			join(fixture.sessionDir, "handover.json"),
			fixture.sessionDir,
			store,
		);
		await first.poll();
		assert.equal(first.submitted().length, 1, "the poll submitted no prompt");

		/* A restart of the session loads the mod again. The mod reads the
		   file of the delivered notes, so the note stays delivered. */
		const second = await startMod(
			fixture,
			join(fixture.sessionDir, "handover.json"),
			fixture.sessionDir,
			store,
		);
		await second.poll();
		assert.equal(second.submitted().length, 0, "the restart submitted the note again");
	} finally {
		await fixture.close();
	}
});

test("a note waits while a permission request is open", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "The build fails on Windows.",
			at: Date.now(),
		});
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		await mod.askPermission("call-1");
		await mod.poll();
		assert.equal(mod.submitted().length, 0, "the poll submitted a note during a permission request");
		await mod.settlePermission("call-1");
		await mod.poll();
		assert.equal(mod.submitted().length, 1, "the note did not arrive after the permission request");
	} finally {
		await fixture.close();
	}
});

test("a turn that carries a note is not an instruction cycle", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const handler = mod.handler("turn.start");
		assert.ok(handler, "the mod registers no turn start handler");
		await handler(mod.dollar, { turnId: "turn-1", text: "The task of the worker." }, () => undefined);
		const bodies = mod.bodies();
		const starts = bodies.filter((body) => body.source === "turn.start");
		assert.equal(starts.length, 1, "the mod posted no turn start");

		await handler(
			mod.dollar,
			{ turnId: "turn-2", text: `${PREFIX} The build fails on Windows.` },
			() => undefined,
		);
		const after = mod.bodies().filter((body) => body.source === "turn.start");
		assert.equal(after.length, 1, "the note turn counted as an instruction cycle");
		const notes = mod.bodies().filter((body) => body.source === "note.turn");
		assert.equal(notes.length, 1, "the mod posted no note turn");
	} finally {
		await fixture.close();
	}
});

test("the worker tool writes a note that the main session reads", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const handler = mod.toolHandler(NOTE_TO_MAIN);
		assert.ok(handler, "the mod registers no handler for the note tool");
		const result = await handler(
			mod.dollar,
			{ text: "The build fails on Windows.", tool: NOTE_TO_MAIN },
			() => undefined,
		);
		assert.equal(toolResult(result).isError, undefined);
		const notes = readChannelNotes(fixture.sessionDir, "worker");
		assert.equal(notes.length, 1);
		assert.equal(notes[0].text, "The build fails on Windows.");
	} finally {
		await fixture.close();
	}
});

test("the worker tool reads the notes of the main session", async () => {
	const fixture = await startFixture();
	try {
		appendChannelNote(fixture.sessionDir, "main", {
			runId: null,
			text: "Use the channel for the next fact.",
			at: Date.now(),
		});
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const handler = mod.toolHandler(NOTES_FROM_MAIN);
		assert.ok(handler, "the mod registers no handler for the notes tool");
		const result = await handler(mod.dollar, { tool: NOTES_FROM_MAIN }, () => undefined);
		const text = toolResult(result).result ?? "";
		assert.match(text, /Use the channel for the next fact\./);
	} finally {
		await fixture.close();
	}
});

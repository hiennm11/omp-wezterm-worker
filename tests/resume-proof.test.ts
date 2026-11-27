/**
 * The proof of a resume.
 *
 * A resume shares the transcript of its source run. The memory plugin
 * appends an entry at the start of every session, so the size of that
 * transcript proves nothing about the delivery of the message.
 *
 * The proof of a resume is therefore the text of the message. The tests use
 * real transcripts in temporary directories.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resumeEvidence } from "../extensions/lib/launch-delivery.ts";
import {
	appendSessionEntry,
	bootstrapEntry,
	userMessageEntry,
	writeSourceTranscript,
} from "./delivery-helpers.ts";

/** The message of a resume. */
const MESSAGE = "Continue with the parser only";

/** A session directory in a fresh directory. */
function sessionDir(): { dir: string; sessionDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-resume-proof-"));
	const session = join(dir, "session");
	mkdirSync(session, { recursive: true });
	return { dir, sessionDir: session };
}

test("a bootstrap entry does not confirm the delivery of a resume message", () => {
	const { dir, sessionDir: session } = sessionDir();
	try {
		writeSourceTranscript(session);
		const found = resumeEvidence(session, MESSAGE);
		assert.equal(found(), false, "the proof was true before any send");

		/* The memory plugin appends an entry at the start of every session.
		   That entry grows the transcript, but it records no user message. */
		appendSessionEntry(session, bootstrapEntry());
		assert.equal(found(), false, "the bootstrap entry confirmed the delivery");

		appendSessionEntry(session, userMessageEntry(MESSAGE));
		assert.equal(found(), true, "the message did not confirm the delivery");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a message that the transcript already held does not confirm the delivery", () => {
	const { dir, sessionDir: session } = sessionDir();
	try {
		writeSourceTranscript(session);
		appendSessionEntry(session, userMessageEntry(MESSAGE));
		const found = resumeEvidence(session, MESSAGE);
		assert.equal(found(), false, "an old message confirmed the delivery");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

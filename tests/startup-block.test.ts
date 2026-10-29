/**
 * The startup block of a native worker.
 *
 * A Claude Code worker in a new repository waits at the trust dialog of
 * Claude Code. The session does not start while the dialog is open, so the
 * missing session start is the fact. The pane text only names the cause.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { startupBlockReason } from "../extensions/lib/startup-block.ts";

const LAUNCH = 1_000_000;
const DIALOG =
	"Is this a project you created or one you trust?\n" +
	"1. No, exit\n" +
	"2. Yes, I trust this folder";

test("the three facts give the reason of the trust dialog", () => {
	assert.equal(startupBlockReason(null, LAUNCH, LAUNCH + 61_000, DIALOG), "trust_dialog");
});

test("a session that started gives no reason", () => {
	assert.equal(startupBlockReason("session-1", LAUNCH, LAUNCH + 61_000, DIALOG), null);
});

test("a launch of 59 seconds gives no reason and a launch of 61 seconds gives the reason", () => {
	assert.equal(startupBlockReason(null, LAUNCH, LAUNCH + 59_000, DIALOG), null);
	assert.equal(startupBlockReason(null, LAUNCH, LAUNCH + 61_000, DIALOG), "trust_dialog");
});

test("a pane without the words of the dialog gives no reason", () => {
	assert.equal(startupBlockReason(null, LAUNCH, LAUNCH + 61_000, "Claude Code is ready"), null);
});

test("the words of the dialog are found without case", () => {
	assert.equal(startupBlockReason(null, LAUNCH, LAUNCH + 61_000, "YES, I TRUST THIS FOLDER"), "trust_dialog");
});

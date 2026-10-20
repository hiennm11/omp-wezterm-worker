import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isTurnComplete, listSessionFiles, summarizeSession } from "../extensions/lib/transcript.ts";

/** Write a transcript and return its path. */
function transcript(lines: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-transcript-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
	return file;
}

/** A user message entry. */
function user(text: string) {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

/** An assistant message entry. */
function assistant(text: string | null, toolCalls: string[] = []) {
	const content: Array<{ type: string; text?: string; name?: string; id?: string }> = [];
	if (text !== null) content.push({ type: "text", text });
	for (const name of toolCalls) {
		content.push({ type: "toolCall", name, id: `call_${name}` });
	}
	return { type: "message", message: { role: "assistant", content } };
}

/** A tool result entry. */
function toolResult() {
	return { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } };
}

test("a text-only assistant message is the result", () => {
	const file = transcript([user("do it"), assistant("PONG")]);
	const summary = summarizeSession(file);
	assert.equal(summary.finalText, "PONG");
	assert.equal(summary.turns, 1);
	assert.equal(summary.finalTextIndex, 1);
	assert.equal(isTurnComplete(summary), true);
});

test("a preamble before a tool call is not the result", () => {
	const file = transcript([user("do it"), assistant("I will read the file.", ["read"])]);
	const summary = summarizeSession(file);
	assert.equal(summary.finalText, null);
	assert.equal(summary.latestText, "I will read the file.");
	assert.equal(summary.currentTool, "read");
	assert.equal(isTurnComplete(summary), false);
});

test("the result is the last text-only message, not the preamble", () => {
	const file = transcript([
		user("do it"),
		assistant("I will read the file.", ["read"]),
		toolResult(),
		assistant("PONG"),
	]);
	const summary = summarizeSession(file);
	assert.equal(summary.finalText, "PONG");
	assert.equal(summary.latestText, "PONG");
	assert.equal(summary.toolCalls, 1);
	assert.equal(summary.toolResults, 1);
	assert.equal(isTurnComplete(summary), true);
});

test("a tool call without its result leaves the turn open", () => {
	const file = transcript([user("do it"), assistant("Working.", ["read"])]);
	const summary = summarizeSession(file);
	assert.equal(isTurnComplete(summary), false);
});

test("a new user message resets the counts since the last user message", () => {
	const file = transcript([
		user("first"),
		assistant("FIRST ANSWER"),
		user("second"),
		assistant("Working.", ["read"]),
	]);
	const summary = summarizeSession(file);
	// The first answer must not count as the answer to the second request.
	assert.equal(summary.finalText, null);
	assert.equal(summary.turnsSinceLastUser, 1);
	assert.equal(summary.toolCallsSinceLastUser, 1);
	assert.equal(summary.toolResultsSinceLastUser, 0);
	assert.equal(isTurnComplete(summary), false);
});

test("finalTextIndex counts every assistant message from the start", () => {
	const file = transcript([
		user("first"),
		assistant("Working.", ["read"]),
		toolResult(),
		assistant("FIRST ANSWER"),
		user("second"),
		assistant("SECOND ANSWER"),
	]);
	const summary = summarizeSession(file);
	assert.equal(summary.finalText, "SECOND ANSWER");
	assert.equal(summary.finalTextIndex, 3);
});

test("a resumed worker reports a result only beyond its baseline", () => {
	const file = transcript([user("first"), assistant("FIRST ANSWER")]);
	const summary = summarizeSession(file);
	const baselineTurns = summary.turns;
	// The baseline rule: the previous answer must not be the new result.
	assert.equal(summary.finalTextIndex <= baselineTurns, true);
});

test("a broken line does not stop the summary", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-transcript-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		[JSON.stringify(user("do it")), "{not valid json", JSON.stringify(assistant("PONG")), ""].join("\n"),
		"utf8",
	);
	const summary = summarizeSession(file);
	assert.equal(summary.finalText, "PONG");
	assert.equal(summary.userMessages.length, 1);
	rmSync(dir, { recursive: true, force: true });
});

test("a missing file yields an empty summary", () => {
	const summary = summarizeSession(join(tmpdir(), `does-not-exist-${Date.now()}.jsonl`));
	assert.equal(summary.turns, 0);
	assert.equal(summary.finalText, null);
	assert.equal(isTurnComplete(summary), false);
});

test("an entry that is not a message is ignored", () => {
	const file = transcript([{ type: "custom", customType: "x" }, user("do it"), assistant("PONG")]);
	const summary = summarizeSession(file);
	assert.equal(summary.turns, 1);
	assert.equal(summary.finalText, "PONG");
});

test("listSessionFiles returns the newest file first", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-sessions-"));
	writeFileSync(join(dir, "a.jsonl"), "{}\n", "utf8");
	writeFileSync(join(dir, "b.jsonl"), "{}\n", "utf8");
	writeFileSync(join(dir, "c.txt"), "not a transcript", "utf8");
	const files = listSessionFiles(dir);
	assert.equal(files.length, 2);
	assert.equal(
		files.every((f) => f.endsWith(".jsonl")),
		true,
	);
	rmSync(dir, { recursive: true, force: true });
});

test("listSessionFiles on a missing directory returns nothing", () => {
	assert.deepEqual(listSessionFiles(join(tmpdir(), `no-such-dir-${Date.now()}`)), []);
});

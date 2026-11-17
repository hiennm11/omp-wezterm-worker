import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { summarizeSession } from "../extensions/lib/transcript.ts";

/** Write a transcript and return its path. */
function transcript(lines: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-transcript-edits-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
	return file;
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

test("the summary counts the calls that change a file", () => {
	const file = transcript([assistant(null, ["edit", "write", "ast_edit", "read"])]);
	const summary = summarizeSession(file);
	assert.equal(summary.editCalls, 3);
});

test("a transcript without a change call counts zero", () => {
	const file = transcript([assistant(null, ["read", "grep"])]);
	const summary = summarizeSession(file);
	assert.equal(summary.editCalls, 0);
});

test("a change call in a message with text is counted", () => {
	const file = transcript([assistant("I change the file now.", ["edit"])]);
	const summary = summarizeSession(file);
	assert.equal(summary.editCalls, 1);
});

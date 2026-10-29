import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { initializeParams, observationOf, secretFields } from "../tooling/backend-proof/codex.ts";
import { approvalDialogShown } from "../tooling/backend-proof/codex-tui.ts";

const ROOT = join(import.meta.dirname, "..");

/** The text of a real pane of the Codex TUI that shows the approval dialog. */
const APPROVAL_PANE = readFileSync(
	join(ROOT, "tests", "fixtures", "codex-approval-pane.txt"),
	"utf8",
);

test("a notification gives the source of its method", () => {
	const observation = observationOf({ method: "turn/started", params: { turn: { id: "t1" } } });
	assert.equal(observation.source, "codex.turn/started");
	assert.deepEqual(observation.payload, { turn: { id: "t1" } });
});

test("a request gives the source of its method", () => {
	const observation = observationOf({ id: 4, method: "item/commandExecution/requestApproval" });
	assert.equal(observation.source, "codex.item/commandExecution/requestApproval");
});

test("a response gives the source of a response and keeps its id", () => {
	const observation = observationOf({ id: 7, result: { ok: true } });
	assert.equal(observation.source, "codex.response");
	assert.deepEqual(observation.payload, { id: 7, result: { ok: true } });
});

test("a message without a method and without an id gives the unknown source", () => {
	const observation = observationOf({});
	assert.equal(observation.source, "codex.unknown");
});

test("the initialize request holds no token", () => {
	assert.deepEqual(secretFields(initializeParams()), []);
});

test("the real pane text of the approval dialog shows the dialog", () => {
	assert.equal(approvalDialogShown(APPROVAL_PANE), true);
});

test("a pane text without a dialog does not show the dialog", () => {
	assert.equal(approvalDialogShown("OpenAI Codex (v0.165.0)\nAsk Codex to do anything"), false);
});

test("an empty pane text does not show the dialog", () => {
	assert.equal(approvalDialogShown(""), false);
});

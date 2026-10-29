import assert from "node:assert/strict";
import { test } from "node:test";

import { observationOf } from "../tooling/backend-proof/codex.ts";

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

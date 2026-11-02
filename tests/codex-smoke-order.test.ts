import assert from "node:assert/strict";
import { test } from "node:test";

import {
	cycleCountOf,
	daemonSurvived,
	STEER_EVENT_ORDER,
	steerEventOrder,
	steerOrderText,
	userPanesSurvived,
} from "../tooling/codex-smoke-steps.ts";

/** The events of a steering instruction in the order of the contract. */
const ORDERED = {
	"steer answer": 1000,
	"turn/started": 2000,
	"instruction delivered": 3000,
	"first report": 4000,
} as const;

test("the order of the events of a steering instruction names the four facts", () => {
	assert.deepEqual(
		[...STEER_EVENT_ORDER],
		["steer answer", "turn/started", "instruction delivered", "first report"],
	);
});

test("the order of the events of a steering instruction keeps the contract", () => {
	const verdict = steerEventOrder(ORDERED);
	assert.deepEqual(verdict.missing, []);
	assert.equal(verdict.ordered, true);
	assert.deepEqual(verdict.order, [...STEER_EVENT_ORDER]);
});

test("a delivery before the turn start breaks the order", () => {
	const verdict = steerEventOrder({
		"steer answer": 1000,
		"turn/started": 3000,
		"instruction delivered": 2000,
		"first report": 4000,
	});
	assert.equal(verdict.ordered, false);
	assert.deepEqual(verdict.missing, []);
});

test("a report before the delivery breaks the order", () => {
	const verdict = steerEventOrder({
		"steer answer": 1000,
		"turn/started": 2000,
		"instruction delivered": 4000,
		"first report": 3000,
	});
	assert.equal(verdict.ordered, false);
});

test("an event that never arrived is missing", () => {
	const verdict = steerEventOrder({
		"steer answer": 1000,
		"turn/started": 2000,
		"instruction delivered": 3000,
	});
	assert.deepEqual(verdict.missing, ["first report"]);
	assert.equal(verdict.ordered, true);
});

test("the text of the order names every event and its time", () => {
	const text = steerOrderText(ORDERED);
	assert.ok(text.includes("steer answer: 1000"), text);
	assert.ok(text.includes("turn/started: 2000"), text);
	assert.ok(text.includes("instruction delivered: 3000"), text);
	assert.ok(text.includes("first report: 4000"), text);
	assert.ok(text.includes("steer answer -> turn/started -> instruction delivered -> first report"), text);
});

test("the text of the order names a missing event", () => {
	const text = steerOrderText({ "steer answer": 1000 });
	assert.ok(text.includes("first report: missing"), text);
	assert.ok(text.includes("missing: turn/started"), text);
});

test("the daemon of the user survives when every process id stays", () => {
	assert.equal(daemonSurvived([10, 20], [10, 20, 30]), true);
});

test("the daemon of the user fails when a process id is gone", () => {
	assert.equal(daemonSurvived([10, 20], [10]), false);
});

test("the daemon of the user fails when the machine held no daemon", () => {
	assert.equal(daemonSurvived([], [10]), false);
});

test("the panes of the user survive when every pane id stays", () => {
	assert.equal(userPanesSurvived([0, 90], [0, 90, 91]), true);
});

test("the panes of the user fail when a pane id is gone", () => {
	assert.equal(userPanesSurvived([0, 90], [0]), false);
});

/** The text of the status tool for one running worker. */
const STATUS = [
	"wz-1  RUNNING",
	"  label      : codex-smoke",
	"  backend   : Codex",
	"  pane      : 5",
	"  native    : cycle 01a1, 0 open call(s), 0 open approval(s), 1 report(s)",
	"  turns     : 2",
	"  tokens    : unknown",
].join("\n");

test("the status shows the number of cycles of a worker", () => {
	assert.equal(cycleCountOf(STATUS, "wz-1"), 2);
});

test("the status shows no cycles of an unknown worker", () => {
	assert.equal(cycleCountOf(STATUS, "wz-2"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { recommend } from "../tooling/eval/recommend.ts";
import type { ReportCell } from "../tooling/eval/types.ts";

/** The fields that a cell overrides. */
type Overrides = Partial<ReportCell>;

/**
 * Build a cell of a report.
 *
 * The fields of the cell override the fields of the default cell. A field
 * that the caller does not give holds its default.
 */
function buildCell(overrides: Overrides = {}): ReportCell {
	return {
		taskType: "bugfix",
		model: "omniroute/minimax/MiniMax-M3.1-Flash",
		effort: "medium",
		runs: 4,
		pass: 4,
		fail: 0,
		blocked: 0,
		valid: 4,
		successRate: 1,
		usageMeasured: 4,
		usagePartial: 0,
		usageUnknown: 0,
		medianWallMs: 41000,
		medianTurns: 13,
		costKnownSum: 0.09,
		costComplete: true,
		...overrides,
	};
}

test("a cell with fewer than three valid runs is not eligible", () => {
	const cell = buildCell({ runs: 4, pass: 2, fail: 0, valid: 2, successRate: 1 });
	const result = recommend([cell], "bugfix");
	assert.equal(result.recommended, null);
	assert.equal(result.fallback, null);
	assert.ok(result.reason.includes("3"));
});

test("a cell with a valid share below 0.8 is not eligible", () => {
	const cell = buildCell({ runs: 5, pass: 3, fail: 0, blocked: 2, valid: 3, successRate: 1 });
	const result = recommend([cell], "bugfix");
	assert.equal(result.recommended, null);
	assert.ok(result.reason.includes("0.8"));
});

test("the success rate decides first", () => {
	const better = buildCell({
		model: "omniroute/cc/claude-opus-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
	});
	const worse = buildCell({ model: "omniroute/cc/claude-haiku-5-5", successRate: 0.5 });
	const result = recommend([worse, better], "bugfix");
	assert.equal(result.recommended?.model, "omniroute/cc/claude-opus-5-5");
});

test("the measured usage decides a tie of the success rate", () => {
	const measured = buildCell({
		model: "omniroute/cc/claude-opus-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
		usageMeasured: 4,
	});
	const partial = buildCell({
		model: "omniroute/cc/claude-haiku-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
		usageMeasured: 1,
		usagePartial: 3,
	});
	const result = recommend([partial, measured], "bugfix");
	assert.equal(result.recommended?.model, "omniroute/cc/claude-opus-5-5");
});

test("a cell with an incomplete cost loses to a cell with a complete cost", () => {
	const complete = buildCell({
		model: "omniroute/cc/claude-opus-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
		usageMeasured: 2,
		costKnownSum: 0.5,
		costComplete: true,
	});
	const incomplete = buildCell({
		model: "omniroute/cc/claude-haiku-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
		usageMeasured: 2,
		costKnownSum: 0.01,
		costComplete: false,
	});
	const result = recommend([incomplete, complete], "bugfix");
	assert.equal(result.recommended?.model, "omniroute/cc/claude-opus-5-5");
});

test("the median time decides the last tie", () => {
	const fast = buildCell({
		model: "omniroute/cc/claude-opus-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
		usageMeasured: 2,
		medianWallMs: 20000,
	});
	const slow = buildCell({
		model: "omniroute/cc/claude-haiku-5-5",
		pass: 3,
		fail: 1,
		valid: 4,
		successRate: 0.75,
		usageMeasured: 2,
		medianWallMs: 60000,
	});
	const result = recommend([slow, fast], "bugfix");
	assert.equal(result.recommended?.model, "omniroute/cc/claude-opus-5-5");
});

test("the second cell of the ranking is the fallback", () => {
	const first = buildCell({ model: "omniroute/cc/claude-opus-5-5" });
	const second = buildCell({ model: "omniroute/cc/claude-haiku-5-5" });
	const result = recommend([first, second], "bugfix");
	assert.equal(result.recommended?.model, "omniroute/cc/claude-opus-5-5");
	assert.equal(result.fallback?.model, "omniroute/cc/claude-haiku-5-5");
});

test("no eligible cell gives a null recommendation and a reason", () => {
	const cell = buildCell({ runs: 1, pass: 0, fail: 0, valid: 0, successRate: 0 });
	const result = recommend([cell], "bugfix");
	assert.equal(result.recommended, null);
	assert.equal(result.fallback, null);
	assert.ok(result.reason.length > 0);
});

test("the cells of another task type never appear", () => {
	const other = buildCell({ taskType: "testing", model: "omniroute/cc/claude-opus-5-5" });
	const result = recommend([other], "bugfix");
	assert.equal(result.recommended, null);
	assert.ok(result.reason.length > 0);
});

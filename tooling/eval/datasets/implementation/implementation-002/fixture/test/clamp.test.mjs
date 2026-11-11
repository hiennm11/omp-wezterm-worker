import assert from "node:assert/strict";
import { test } from "node:test";

import { clamp } from "../src/clamp.mjs";

test("clamp keeps a value inside the range", () => {
	assert.equal(clamp(5, 0, 10), 5);
});

test("clamp raises a value below the minimum", () => {
	assert.equal(clamp(-3, 0, 10), 0);
});

test("clamp lowers a value above the maximum", () => {
	assert.equal(clamp(42, 0, 10), 10);
});

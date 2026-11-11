import assert from "node:assert/strict";
import { test } from "node:test";

import { isEven } from "../src/even.mjs";

test("isEven accepts an even number", () => {
	assert.equal(isEven(4), true);
});

test("isEven refuses an odd number", () => {
	assert.equal(isEven(7), false);
});

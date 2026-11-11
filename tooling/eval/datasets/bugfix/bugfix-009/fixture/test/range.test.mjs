import assert from "node:assert/strict";
import { test } from "node:test";

import { sliceRange } from "../src/range.mjs";

test("sliceRange leaves out the end index", () => {
	assert.deepEqual(sliceRange([1, 2, 3, 4, 5], 1, 3), [2, 3]);
});

test("sliceRange takes nothing when the range is empty", () => {
	assert.deepEqual(sliceRange([1, 2, 3], 1, 1), []);
});

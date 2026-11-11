import assert from "node:assert/strict";
import { test } from "node:test";

import { chunk } from "../src/chunk.mjs";

test("chunk splits the items into parts of the given size", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("chunk gives an empty list for an empty input", () => {
	assert.deepEqual(chunk([], 3), []);
});

test("chunk gives one part when the size covers every item", () => {
	assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

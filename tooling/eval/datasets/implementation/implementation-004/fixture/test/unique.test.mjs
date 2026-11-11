import assert from "node:assert/strict";
import { test } from "node:test";

import { unique } from "../src/unique.mjs";

test("unique removes the repeated items", () => {
	assert.deepEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3]);
});

test("unique keeps the order of the first appearance", () => {
	assert.deepEqual(unique(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
});

test("unique gives an empty list for an empty input", () => {
	assert.deepEqual(unique([]), []);
});

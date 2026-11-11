import assert from "node:assert/strict";
import { test } from "node:test";

import { copyRange } from "../src/copy-range.mjs";

test("copyRange copies the items before the end index", () => {
	assert.deepEqual(copyRange([1, 2, 3, 4], 2), [1, 2]);
});

test("copyRange copies nothing when the end index is zero", () => {
	assert.deepEqual(copyRange([1, 2, 3, 4], 0), []);
});

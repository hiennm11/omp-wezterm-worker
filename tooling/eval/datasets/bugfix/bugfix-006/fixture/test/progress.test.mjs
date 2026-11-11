import assert from "node:assert/strict";
import { test } from "node:test";

import { percent } from "../src/progress.mjs";

test("percent truncates the value", () => {
	assert.equal(percent(2, 3), 66);
});

test("percent gives a whole value", () => {
	assert.equal(percent(1, 2), 50);
});

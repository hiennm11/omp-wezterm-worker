import assert from "node:assert/strict";
import { test } from "node:test";

import { levelFor } from "../src/level.mjs";

test("levelFor names a high score", () => {
	assert.equal(levelFor(80), "high");
});

test("levelFor names a medium score", () => {
	assert.equal(levelFor(50), "medium");
});

test("levelFor names a medium score below the high threshold", () => {
	assert.equal(levelFor(75), "medium");
});

test("levelFor names a low score", () => {
	assert.equal(levelFor(10), "low");
});

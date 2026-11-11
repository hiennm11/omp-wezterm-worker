import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDuration } from "../src/parse-duration.mjs";

test("parseDuration reads hours and minutes", () => {
	assert.equal(parseDuration("1h30m"), 5400000);
});

test("parseDuration reads minutes and seconds", () => {
	assert.equal(parseDuration("2m10s"), 130000);
});

test("parseDuration reads a value of seconds", () => {
	assert.equal(parseDuration("45s"), 45000);
});

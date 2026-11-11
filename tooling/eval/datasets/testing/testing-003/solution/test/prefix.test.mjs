import assert from "node:assert/strict";
import { test } from "node:test";

import { hasPrefix } from "../src/prefix.mjs";

test("hasPrefix accepts a text that starts with the prefix", () => {
	assert.equal(hasPrefix("report", "re"), true);
});

test("hasPrefix refuses a text that only holds the prefix", () => {
	assert.equal(hasPrefix("report", "port"), false);
});

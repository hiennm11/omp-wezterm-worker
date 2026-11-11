import assert from "node:assert/strict";
import { test } from "node:test";

import { labelFor } from "../src/label.mjs";

test("labelFor names a small size", () => {
	assert.equal(labelFor(5), "small");
});

test("labelFor names a medium size", () => {
	assert.equal(labelFor(50), "medium");
});

test("labelFor names a large size", () => {
	assert.equal(labelFor(500), "large");
});

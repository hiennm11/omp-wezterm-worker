import assert from "node:assert/strict";
import { test } from "node:test";

import { truncate } from "../src/truncate.mjs";

test("truncate cuts a long text and adds an ellipsis", () => {
	assert.equal(truncate("abcdefghij", 5), "abcde...");
});

test("truncate keeps a short text", () => {
	assert.equal(truncate("abc", 5), "abc");
});

test("truncate keeps a text of the limit", () => {
	assert.equal(truncate("abcde", 5), "abcde");
});

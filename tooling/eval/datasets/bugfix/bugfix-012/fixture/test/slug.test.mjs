import assert from "node:assert/strict";
import { test } from "node:test";

import { isSlug } from "../src/slug.mjs";

test("isSlug accepts a slug", () => {
	assert.equal(isSlug("report-2026"), true);
});

test("isSlug refuses a text with a space", () => {
	assert.equal(isSlug("report 2026"), false);
});

test("isSlug refuses an empty text", () => {
	assert.equal(isSlug(""), false);
});

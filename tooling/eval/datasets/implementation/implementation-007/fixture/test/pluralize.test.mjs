import assert from "node:assert/strict";
import { test } from "node:test";

import { pluralize } from "../src/pluralize.mjs";

test("pluralize keeps the word for a count of one", () => {
	assert.equal(pluralize(1, "file"), "1 file");
});

test("pluralize adds an s for a count of two", () => {
	assert.equal(pluralize(2, "file"), "2 files");
});

test("pluralize adds an s for a count of zero", () => {
	assert.equal(pluralize(0, "file"), "0 files");
});

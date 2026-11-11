import assert from "node:assert/strict";
import { test } from "node:test";

import { isSameId } from "../src/id.mjs";

test("isSameId accepts two equal numbers", () => {
	assert.equal(isSameId(7, 7), true);
});

test("isSameId refuses a number and a string", () => {
	assert.equal(isSameId("7", 7), false);
});

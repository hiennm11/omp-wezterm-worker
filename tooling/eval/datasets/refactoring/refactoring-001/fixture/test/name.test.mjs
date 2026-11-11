import assert from "node:assert/strict";
import { test } from "node:test";

import { newName } from "../src/new-name.mjs";

test("newName returns the renamed value", () => {
	assert.equal(newName("x"), "old:x");
});

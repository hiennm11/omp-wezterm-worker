import assert from "node:assert/strict";
import { test } from "node:test";

import { label } from "../src/label.mjs";

test("label names the upper case text", () => {
	assert.equal(label("ada"), "name: ADA");
});

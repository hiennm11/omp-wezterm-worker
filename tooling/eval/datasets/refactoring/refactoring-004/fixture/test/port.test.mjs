import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePort } from "../src/port.mjs";

test("parsePort reads a whole number", () => {
	assert.equal(parsePort("8080"), 8080);
});

test("parsePort refuses a text with letters", () => {
	assert.equal(parsePort("http"), null);
});

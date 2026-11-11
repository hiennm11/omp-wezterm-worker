import assert from "node:assert/strict";
import { test } from "node:test";

import { runCommand } from "../src/command.mjs";

test("runCommand doubles a number", () => {
	assert.equal(runCommand("double 21"), 42);
});

test("runCommand returns a number", () => {
	assert.equal(runCommand("value 21"), 21);
});

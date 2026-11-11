import assert from "node:assert/strict";
import { test } from "node:test";

import { isPassing } from "../src/score.mjs";

test("isPassing accepts the threshold itself", () => {
	assert.equal(isPassing(70), true);
});

test("isPassing refuses a score below the threshold", () => {
	assert.equal(isPassing(69), false);
});

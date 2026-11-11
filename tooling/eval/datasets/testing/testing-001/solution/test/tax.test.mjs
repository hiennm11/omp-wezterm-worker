import assert from "node:assert/strict";
import { test } from "node:test";

import { taxFor } from "../src/tax.mjs";

test("taxFor returns ten percent of the amount", () => {
	assert.equal(taxFor(100), 10);
});

test("taxFor returns no tax for an amount of zero", () => {
	assert.equal(taxFor(0), 0);
});

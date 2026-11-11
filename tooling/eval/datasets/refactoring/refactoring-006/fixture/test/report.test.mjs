import assert from "node:assert/strict";
import { test } from "node:test";

import { reportLine } from "../src/report.mjs";

test("reportLine names the value in brackets", () => {
	assert.equal(reportLine("ok"), "[ok]");
});

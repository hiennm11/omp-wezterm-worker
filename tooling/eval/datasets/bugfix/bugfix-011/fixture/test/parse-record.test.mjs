import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRecord } from "../src/parse-record.mjs";

test("parseRecord reads the name and the count", () => {
	assert.deepEqual(parseRecord("name=ada,count=3"), { name: "ada", count: 3 });
});

test("parseRecord gives a count of zero when the field is missing", () => {
	assert.deepEqual(parseRecord("name=ada"), { name: "ada", count: 0 });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "../src/strings.mjs";
import { reportTitle } from "../src/report.mjs";

test("slugify names a lower case text with dashes", () => {
	assert.equal(slugify("Hello World"), "hello-world");
});

test("reportTitle names the title of a report", () => {
	assert.equal(reportTitle("hello"), "Hello");
});

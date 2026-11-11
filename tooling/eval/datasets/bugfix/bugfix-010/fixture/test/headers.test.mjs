import assert from "node:assert/strict";
import { test } from "node:test";

import { headerValue } from "../src/headers.mjs";

test("headerValue finds a header in another case", () => {
	const headers = { "Content-Type": "text/plain" };
	assert.equal(headerValue(headers, "content-type"), "text/plain");
});

test("headerValue finds a header in the same case", () => {
	const headers = { "Content-Type": "text/plain" };
	assert.equal(headerValue(headers, "Content-Type"), "text/plain");
});

test("headerValue gives no value for an absent header", () => {
	assert.equal(headerValue({}, "content-type"), undefined);
});

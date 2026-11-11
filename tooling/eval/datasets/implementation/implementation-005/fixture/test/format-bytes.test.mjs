import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes } from "../src/format-bytes.mjs";

test("formatBytes names a count of bytes", () => {
	assert.equal(formatBytes(512), "512 B");
});

test("formatBytes names a count of kilobytes", () => {
	assert.equal(formatBytes(2048), "2 KB");
});

test("formatBytes names a count of megabytes", () => {
	assert.equal(formatBytes(3 * 1024 * 1024), "3 MB");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeConfig } from "../src/config.mjs";

test("mergeConfig keeps a default value that the overrides do not name", () => {
	assert.deepEqual(mergeConfig({ retries: 3, timeout: 100 }, { timeout: 50 }), {
		retries: 3,
		timeout: 50,
	});
});

test("mergeConfig keeps a value that only the overrides name", () => {
	assert.deepEqual(mergeConfig({ retries: 3 }, { timeout: 50 }), {
		retries: 3,
		timeout: 50,
	});
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	backendRefusal,
	IMPLEMENTED_BACKENDS,
	isRemovedBackend,
	KNOWN_BACKENDS,
	readBackend,
} from "../extensions/lib/backend.ts";

test("a run without a backend field is an OMP run", () => {
	assert.equal(readBackend({}), "omp");
	assert.equal(readBackend({ backend: "claude" }), "claude");
});

test("a run with an unknown backend field is an OMP run", () => {
	assert.equal(readBackend({ backend: "something-else" }), "omp");
});

test("an implemented backend has no refusal", () => {
	assert.equal(backendRefusal("omp"), null);
	assert.equal(backendRefusal("claude"), null);
});

test("a run of the removed backend keeps its value", () => {
	assert.equal(readBackend({ backend: "codex" }), "codex");
	assert.equal(isRemovedBackend({ backend: "codex" }), true);
	assert.equal(isRemovedBackend({ backend: "claude" }), false);
	assert.equal(isRemovedBackend({}), false);
});

test("the removed backend is not a backend that a spawn may name", () => {
	assert.deepEqual(KNOWN_BACKENDS, ["omp", "claude"]);
	assert.deepEqual(IMPLEMENTED_BACKENDS, ["omp", "claude"]);
});

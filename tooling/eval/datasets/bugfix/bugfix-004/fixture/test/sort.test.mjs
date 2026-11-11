import assert from "node:assert/strict";
import { test } from "node:test";

import { sortByLength } from "../src/sort-by-length.mjs";

test("sortByLength sorts the items by their length", () => {
	assert.deepEqual(sortByLength(["ccc", "a", "bb"]), ["a", "bb", "ccc"]);
});

test("sortByLength leaves the input array unchanged", () => {
	const items = ["ccc", "a", "bb"];
	sortByLength(items);
	assert.deepEqual(items, ["ccc", "a", "bb"]);
});

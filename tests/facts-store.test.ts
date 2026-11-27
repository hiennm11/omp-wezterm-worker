/**
 * The store of the facts.
 *
 * The tests use real files in a temporary directory. They drive the store
 * through its own functions, so they prove the file format and the rules of
 * the store.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	appendPromotedFact,
	appendProposedFact,
	appendRetraction,
	factsByKeys,
	promotedFactsFile,
	proposedFactsFile,
	readFacts,
	readPromotedFacts,
	readProposedFacts,
} from "../extensions/lib/facts-store.ts";

/** A temporary directory for one test. */
function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "wt-facts-"));
}

/** The lines of a file. */
function lines(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

test("a proposed fact reaches the file of the session directory", () => {
	const dir = tempDir();
	try {
		const fact = appendProposedFact(dir, {
			key: "build",
			text: "The build fails on Windows.",
			writer: "wz-1",
			at: 100,
		});
		assert.equal(fact.key, "build");
		assert.equal(fact.state, "proposed");
		const file = proposedFactsFile(dir);
		assert.equal(lines(file).length, 1);
		const facts = readProposedFacts(dir);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.text, "The build fails on Windows.");
		assert.equal(facts[0]?.writer, "wz-1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a new fact with an existing key replaces the old fact and the old line stays", () => {
	const dir = tempDir();
	try {
		appendProposedFact(dir, { key: "build", text: "the old text", writer: "wz-1", at: 100 });
		appendProposedFact(dir, { key: "build", text: "the new text", writer: "wz-2", at: 200 });
		assert.equal(lines(proposedFactsFile(dir)).length, 2, "the old line left the file");
		const facts = readProposedFacts(dir);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.text, "the new text");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a partial line is skipped", () => {
	const dir = tempDir();
	try {
		appendProposedFact(dir, { key: "build", text: "a whole fact", writer: "wz-1", at: 100 });
		appendFileSync(proposedFactsFile(dir), '{"key":"partial","tex', "utf8");
		const facts = readProposedFacts(dir);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.key, "build");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the promoted file lives in the facts folder of the state directory", () => {
	const dir = tempDir();
	try {
		assert.equal(promotedFactsFile(dir, "session-1"), join(dir, "facts", "session-1.jsonl"));
		appendPromotedFact(dir, "session-1", {
			key: "build",
			text: "The build fails on Windows.",
			writer: "session-1",
			at: 100,
		});
		assert.equal(lines(promotedFactsFile(dir, "session-1")).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a retraction hides the key and the old line stays", () => {
	const dir = tempDir();
	try {
		appendPromotedFact(dir, "session-1", {
			key: "build",
			text: "The build fails on Windows.",
			writer: "session-1",
			at: 100,
		});
		appendRetraction(dir, "session-1", { key: "build", writer: "session-1", at: 200 });
		assert.equal(lines(promotedFactsFile(dir, "session-1")).length, 2, "the old line left the file");
		const facts = readPromotedFacts(dir, "session-1");
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.state, "retracted");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the read of a key list gives the texts of the promoted facts", () => {
	const dir = tempDir();
	try {
		appendPromotedFact(dir, "session-1", {
			key: "build",
			text: "The build fails on Windows.",
			writer: "session-1",
			at: 100,
		});
		appendPromotedFact(dir, "session-1", {
			key: "path",
			text: "The state directory is the facts folder.",
			writer: "session-1",
			at: 110,
		});
		const result = factsByKeys(promotedFactsFile(dir, "session-1"), ["build", "path"]);
		assert.ok(!("error" in result), "the read refused the keys");
		assert.equal(result.texts.get("build"), "The build fails on Windows.");
		assert.equal(result.texts.get("path"), "The state directory is the facts folder.");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the read of a key list refuses a key that does not exist", () => {
	const dir = tempDir();
	try {
		appendPromotedFact(dir, "session-1", {
			key: "build",
			text: "The build fails on Windows.",
			writer: "session-1",
			at: 100,
		});
		const result = factsByKeys(promotedFactsFile(dir, "session-1"), ["build", "missing"]);
		assert.ok("error" in result, "the read accepted a key that does not exist");
		assert.match(result.error, /missing/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the read of a key list refuses a retracted key", () => {
	const dir = tempDir();
	try {
		appendPromotedFact(dir, "session-1", {
			key: "build",
			text: "The build fails on Windows.",
			writer: "session-1",
			at: 100,
		});
		appendRetraction(dir, "session-1", { key: "build", writer: "session-1", at: 200 });
		const result = factsByKeys(promotedFactsFile(dir, "session-1"), ["build"]);
		assert.ok("error" in result, "the read accepted a retracted key");
		assert.match(result.error, /build/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the read of a key list refuses texts that hold more than 16000 characters", () => {
	const dir = tempDir();
	try {
		appendPromotedFact(dir, "session-1", {
			key: "first",
			text: "x".repeat(9000),
			writer: "session-1",
			at: 100,
		});
		appendPromotedFact(dir, "session-1", {
			key: "second",
			text: "y".repeat(9000),
			writer: "session-1",
			at: 110,
		});
		const result = factsByKeys(promotedFactsFile(dir, "session-1"), ["first", "second"]);
		assert.ok("error" in result, "the read accepted too many characters");
		assert.match(result.error, /16000/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the read of a file skips a line that holds no fact", () => {
	const dir = tempDir();
	try {
		const file = promotedFactsFile(dir, "session-1");
		appendPromotedFact(dir, "session-1", {
			key: "build",
			text: "The build fails on Windows.",
			writer: "session-1",
			at: 100,
		});
		appendFileSync(file, '{"key":"other"}\n', "utf8");
		assert.equal(readFacts(file).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { checkDocument, SENTENCE_LIMIT_DESCRIPTIVE } from "../tooling/ste100.ts";
import { CHECKED_DOCUMENTS, checkFile, REQUIRED_SCORE } from "../tooling/ste100-cli.ts";

const ROOT = join(import.meta.dirname, "..");

test("clean text scores 100", () => {
	const report = checkDocument("The worker reads the transcript. It reports the result.");
	assert.equal(report.score, 100);
	assert.equal(report.totalSentences, 2);
	assert.equal(report.findings.length, 0);
});

test("a long sentence lowers the score", () => {
	const report = checkDocument(
		"The worker polls the transcript file every two seconds and then it checks whether the newest assistant message contains only text so that it can decide if the turn is now complete.",
	);
	assert.ok(report.score < 100);
	assert.equal(
		report.findings.some((f) => f.rule === "SENTENCE_TOO_LONG"),
		true,
	);
});

test("the sentence limit is configurable", () => {
	const sentence = "The worker reads the transcript and it reports the result to the main session.";
	const strict = checkDocument(sentence, { sentenceLimit: 10 });
	assert.equal(
		strict.findings.some((f) => f.rule === "SENTENCE_TOO_LONG"),
		true,
	);
	const loose = checkDocument(sentence, { sentenceLimit: SENTENCE_LIMIT_DESCRIPTIVE });
	assert.equal(
		loose.findings.some((f) => f.rule === "SENTENCE_TOO_LONG"),
		false,
	);
});

test("a semicolon is a finding", () => {
	const report = checkDocument("The worker reads the transcript; it reports the result.");
	assert.equal(
		report.findings.some((f) => f.rule === "SEMICOLON"),
		true,
	);
});

test("an unapproved word is a finding", () => {
	const report = checkDocument("The worker will utilize the transcript.");
	assert.equal(
		report.findings.some((f) => f.rule === "UNAPPROVED_WORD"),
		true,
	);
});

test("a filler word is a finding", () => {
	const report = checkDocument("The worker simply reads the transcript.");
	assert.equal(
		report.findings.some((f) => f.rule === "FILLER_WORD"),
		true,
	);
});

test("a progressive verb form is a finding", () => {
	const report = checkDocument("The worker is processing the request.");
	assert.equal(
		report.findings.some((f) => f.rule === "PROGRESSIVE_TENSE"),
		true,
	);
});

test("a vague modal is a finding", () => {
	const report = checkDocument("The worker should read the transcript.");
	assert.equal(
		report.findings.some((f) => f.rule === "VAGUE_MODAL"),
		true,
	);
});

test("a hedge stays a hedge", () => {
	// The 80% softening keeps probability. A checker that removes it lies.
	const report = checkDocument("The worker may fail to start.");
	assert.equal(
		report.findings.some((f) => f.rule === "VAGUE_MODAL"),
		false,
	);
});

test("a fenced code block is exempt from the rules", () => {
	const code = "const worker = await spawn(bin, args);";
	const report = checkDocument(`The worker starts.\n\n\`\`\`ts\n${code}\n\`\`\`\n`);
	// The semicolon lives in the code. The rules do not apply to code.
	assert.equal(
		report.findings.some((f) => f.rule === "SEMICOLON"),
		false,
	);
	assert.equal(report.totalSentences, 1);
});

test("a sentence next to a code block is still checked", () => {
	const report = checkDocument("The worker starts; it reports the result.\n\n```ts\nconst x = 1;\n```\n");
	assert.equal(
		report.findings.some((f) => f.rule === "SEMICOLON"),
		true,
	);
});

test("an inline code span is exempt", () => {
	const report = checkDocument("Run `wezterm cli list;` to see the panes.");
	assert.equal(
		report.findings.some((f) => f.rule === "SEMICOLON"),
		false,
	);
});

test("a table row is exempt", () => {
	const report = checkDocument(
		"| Tool | Purpose |\n|---|---|\n| `wezterm_spawn_worker` | Starts a worker; it returns the id. |",
	);
	assert.equal(
		report.findings.some((f) => f.rule === "SEMICOLON"),
		false,
	);
});

test("a heading is exempt", () => {
	const report = checkDocument("# The worker lifecycle\n\nThe worker starts.");
	assert.equal(report.totalSentences, 1);
});

test("an empty document scores 100", () => {
	assert.equal(checkDocument("").score, 100);
});

test("every checked document reaches the required score", () => {
	for (const path of CHECKED_DOCUMENTS) {
		const result = checkFile(join(ROOT, path), ROOT);
		const detail = checkDocument(readFileSync(join(ROOT, path), "utf8"));
		const lines = detail.findings
			.slice(0, 5)
			.map((f) => `      line ${f.line} ${f.rule}: ${f.message} — "${f.sentence.slice(0, 70)}"`)
			.join("\n");
		assert.equal(
			result.pass,
			true,
			`${path} scored ${result.score}, the limit is ${REQUIRED_SCORE}\n${lines}`,
		);
	}
});

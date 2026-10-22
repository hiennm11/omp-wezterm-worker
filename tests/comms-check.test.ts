import assert from "node:assert/strict";
import { test } from "node:test";

import { REPORTING_CONTRACT } from "../extensions/lib/bootstrap-prompt.ts";
import { type CommsSettings, checkComms } from "../extensions/lib/comms-check.ts";
import { checkDocument } from "../extensions/lib/ste100.ts";

const WARN: CommsSettings = { mode: "warn", minScore: 80 };
const ENFORCE: CommsSettings = { mode: "enforce", minScore: 80 };
const OFF: CommsSettings = { mode: "off", minScore: 80 };

/** A sentence that breaks the sentence limit of the checker. */
const LONG_SENTENCE =
	"The worker polls the transcript file every two seconds and then it checks whether the newest assistant message contains only text so that it can decide if the turn is now complete.";

test("a clean text passes", () => {
	const result = checkComms("The worker reads the transcript. It reports the result.", "task", WARN);
	assert.equal(result.verdict, "pass");
	assert.equal(result.score, 100);
	assert.deepEqual(result.findings, []);
});

test("a long sentence warns", () => {
	const result = checkComms(LONG_SENTENCE, "task", WARN);
	assert.equal(result.verdict, "warn");
	assert.ok(result.score < 80);
	assert.ok(result.findings.length > 0);
	assert.ok(result.findings.length <= 5);
});

test("the warn mode and the enforce mode give different verdicts", () => {
	const warned = checkComms(LONG_SENTENCE, "task", WARN);
	const refused = checkComms(LONG_SENTENCE, "task", ENFORCE);
	assert.equal(warned.verdict, "warn");
	assert.equal(refused.verdict, "fail");
	assert.equal(warned.score, refused.score);
});

test("a Vietnamese text is skipped", () => {
	const result = checkComms("Hãy đọc tệp nguồn và liệt kê mọi hàm được xuất ra.", "task", WARN);
	assert.equal(result.verdict, "skipped");
	assert.equal(result.findings.length, 0);
});

test("the off mode returns off", () => {
	const result = checkComms(LONG_SENTENCE, "task", OFF);
	assert.equal(result.verdict, "off");
	assert.equal(result.findings.length, 0);
});

test("a short text is skipped", () => {
	const result = checkComms("go now", "steer", WARN);
	assert.equal(result.verdict, "skipped");
});

test("the check keeps the channel of the text", () => {
	assert.equal(checkComms("The worker reads the transcript.", "steer", WARN).channel, "steer");
	assert.equal(checkComms("The worker reads the transcript.", "result", WARN).channel, "result");
});

test("the reporting contract reaches the required score", () => {
	const report = checkDocument(REPORTING_CONTRACT);
	assert.ok(
		report.score >= 80,
		`The reporting contract scored ${report.score}. The findings are: ${report.findings
			.map((f) => `line ${f.line} ${f.rule}: ${f.message}`)
			.join("; ")}`,
	);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as background from "../tooling/backend-proof/codex-background.ts";
import type { CodexProofOptions } from "../tooling/backend-proof/codex-handle.ts";
import { createEvidenceStore } from "../tooling/backend-proof/evidence.ts";

/** The options of one proof run, for the tests of the background evidence. */
function testOptions(): CodexProofOptions {
	const dir = mkdtempSync(join(tmpdir(), "proof-background-"));
	return {
		args: { backend: "codex", scenario: "background", evidenceDir: dir },
		runId: "proof-background-test",
		evidence: createEvidenceStore(dir, "codex", "proof-background-test"),
		observations: [],
	};
}

/** The facts that the tests of the background verdict change. */
interface BackgroundCase {
	/** Whether a command of the turn completed. */
	commandCompleted?: boolean;
	/** The time of the first report. */
	reportAt: number | null;
	/** Whether the background file appeared. */
	fileAppeared: boolean;
	/** The time of the last write of the file. */
	fileAt?: number | null;
	/** The content of the background file. */
	fileContent?: string | null;
}

/** Build the facts of one case of the background verdict. */
function backgroundFacts(testCase: BackgroundCase): background.BackgroundFacts {
	return {
		commandCompleted: testCase.commandCompleted ?? true,
		reportArrived: testCase.reportAt !== null,
		reportAt: testCase.reportAt,
		fileAppeared: testCase.fileAppeared,
		fileAt: testCase.fileAt ?? null,
		fileContent: testCase.fileContent ?? null,
		waitedMs: 40000,
	};
}

test("the background task names the absolute path of the file", () => {
	const text = background.backgroundTaskText("C:/tmp/proof/fixture");
	assert.ok(text.includes("C:/tmp/proof/fixture/bg.txt"), text);
	assert.ok(!text.includes("\\"), text);
	assert.ok(text.includes("BG-DONE"), text);
	assert.ok(text.includes("PROOF-BACKGROUND"), text);
});

test("a background file that appears after the report passes", () => {
	const verdict = background.backgroundVerdict(
		backgroundFacts({ reportAt: 1000, fileAppeared: true, fileAt: 21000, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "pass");
	assert.ok(verdict.detail.includes("20"), verdict.detail);
});

test("a background file that appears before the report fails", () => {
	const verdict = background.backgroundVerdict(
		backgroundFacts({ reportAt: 21000, fileAppeared: true, fileAt: 1000, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("background"), verdict.detail);
});

test("a background file that never appears fails", () => {
	const verdict = background.backgroundVerdict(backgroundFacts({ reportAt: 1000, fileAppeared: false }));
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("40"), verdict.detail);
});

test("a background turn without a report fails", () => {
	const verdict = background.backgroundVerdict(
		backgroundFacts({ reportAt: null, fileAppeared: true, fileAt: 21000, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("report"), verdict.detail);
});

test("a background file with a wrong content fails", () => {
	const verdict = background.backgroundVerdict(
		backgroundFacts({ reportAt: 1000, fileAppeared: true, fileAt: 21000, fileContent: "SOMETHING-ELSE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("BG-DONE"), verdict.detail);
});

test("a background turn without a command fails", () => {
	const verdict = background.backgroundVerdict(
		backgroundFacts({
			commandCompleted: false,
			reportAt: 1000,
			fileAppeared: true,
			fileAt: 21000,
			fileContent: "BG-DONE",
		}),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("command"), verdict.detail);
});

test("a file that was written before the report keeps the time of its write", () => {
	const at = background.backgroundFileTime(true, 1000, 30000);
	assert.equal(at, 1000);
	const verdict = background.backgroundVerdict(
		backgroundFacts({ reportAt: 21000, fileAppeared: true, fileAt: at, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("background"), verdict.detail);
});

test("a file that never existed has no time", () => {
	assert.equal(background.backgroundFileTime(false, null, 30000), null);
});

test("the time of a file is the time of its last write", async () => {
	const dir = mkdtempSync(join(tmpdir(), "proof-background-"));
	const path = join(dir, "bg.txt");
	writeFileSync(path, "BG-DONE", "utf8");
	const written = Math.floor((Date.now() - 60000) / 1000) * 1000;
	utimesSync(path, new Date(written), new Date(written));
	const file = await background.waitForBackgroundFile(path);
	assert.equal(file.appeared, true);
	assert.equal(file.content, "BG-DONE");
	assert.equal(file.at, written);
});

test("the background task asks the model not to wait for the process", () => {
	const text = background.backgroundTaskText("C:/tmp/proof/fixture");
	assert.ok(text.includes("60 seconds"), text);
	assert.ok(text.includes("Do not wait for the process to finish."), text);
});

test("the evidence of the background scenario holds the end of the turn", () => {
	const options = testOptions();
	options.observations.push({ source: "codex.turn/completed", payload: {}, at: 5000 });
	const file: background.BackgroundFile = {
		path: "C:/tmp/proof/fixture/bg.txt",
		appeared: true,
		at: 9000,
		content: "BG-DONE",
		waitedMs: 10000,
	};
	background.backgroundFacts(options, "background", file);
	const lines = readFileSync(join(options.evidence.dir, "observations.jsonl"), "utf8");
	assert.ok(lines.includes("background.turn-completed"), lines);
});

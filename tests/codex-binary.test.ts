import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
	codexBinaryCandidates,
	codexVersionRefusal,
	MIN_CODEX_VERSION,
	parseCodexVersion,
} from "../extensions/lib/codex-binary.ts";

/** The npm folder of the machine of the test. */
const NPM_ROOT = join("C:", "Users", "yoga", "AppData", "Roaming", "npm");

/** The output of the command `where codex` on the machine of the test. */
const WHERE_OUTPUT = [join(NPM_ROOT, "codex"), join(NPM_ROOT, "codex.cmd")].join("\r\n");

/** The path of the Codex binary inside the npm folder. */
const EXPECTED_EXE = join(
	NPM_ROOT,
	"node_modules",
	"@openai",
	"codex",
	"node_modules",
	"@openai",
	"codex-win32-x64",
	"vendor",
	"x86_64-pc-windows-msvc",
	"bin",
	"codex.exe",
);

/** The second path of the Codex binary inside the npm folder. */
const EXPECTED_SECOND_EXE = join(
	NPM_ROOT,
	"node_modules",
	"@openai",
	"codex-win32-x64",
	"vendor",
	"x86_64-pc-windows-msvc",
	"bin",
	"codex.exe",
);

/** The old fixed path of the proof. */
const LEGACY_PATH =
	"C:/Program Files/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

test("the parser reads the version of the Codex program", () => {
	assert.equal(parseCodexVersion("codex-cli 0.147.0"), "0.147.0");
});

test("an unreadable text holds no version", () => {
	assert.equal(parseCodexVersion("codex-cli unknown"), null);
});

test("an empty text holds no version", () => {
	assert.equal(parseCodexVersion(""), null);
});

test("a version that is too low is refused", () => {
	const refusal = codexVersionRefusal("codex-cli 0.147.0");
	assert.ok(refusal, "the refusal is missing");
	assert.match(refusal, /0\.147\.0/);
	assert.match(refusal, /0\.166\.0/);
});

test("a version that cannot be parsed is refused", () => {
	const refusal = codexVersionRefusal("codex-cli unknown");
	assert.ok(refusal, "the refusal is missing");
	assert.match(refusal, /0\.166\.0/);
});

test("a missing version is refused", () => {
	const refusal = codexVersionRefusal(null);
	assert.ok(refusal, "the refusal is missing");
	assert.match(refusal, /0\.166\.0/);
});

test("the version that the extension needs is not refused", () => {
	assert.equal(codexVersionRefusal(`codex-cli ${MIN_CODEX_VERSION}`), null);
});

test("a version above the minimum is not refused", () => {
	assert.equal(codexVersionRefusal("codex-cli 0.170.0"), null);
});

test("the first candidate is the Codex binary of the npm folder", () => {
	const candidates = codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT);
	assert.equal(candidates[0], EXPECTED_EXE);
});

test("the candidates are the same as before the move", () => {
	assert.deepEqual(codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT), [
		EXPECTED_EXE,
		EXPECTED_SECOND_EXE,
		LEGACY_PATH,
	]);
});

test("a candidate ends in codex.exe", () => {
	for (const candidate of codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT)) {
		assert.ok(candidate.endsWith("codex.exe"), `the candidate ${candidate} holds another program`);
	}
});

test("the old fixed path stays a candidate", () => {
	const candidates = codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT);
	assert.ok(candidates.includes(LEGACY_PATH));
});

test("no candidate is a shell", () => {
	for (const candidate of codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT)) {
		assert.doesNotMatch(candidate, /cmd\.exe|powershell\.exe|\.cmd$/i);
	}
});

test("an empty output still gives the binary of the npm root", () => {
	const candidates = codexBinaryCandidates("", NPM_ROOT);
	assert.equal(candidates[0], EXPECTED_EXE);
});

test("the candidates hold no duplicate", () => {
	const candidates = codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT);
	assert.equal(new Set(candidates).size, candidates.length);
});

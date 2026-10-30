import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { codexBinaryCandidates } from "../tooling/backend-proof/codex-binary.ts";

/** The npm folder of the machine of the proof. */
const NPM_ROOT = join("C:", "Users", "yoga", "AppData", "Roaming", "npm");

/** The output of the command `where codex` on the machine of the proof. */
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

/** The old fixed path of the proof. */
const LEGACY_PATH =
	"C:/Program Files/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

test("the first candidate is the Codex binary of the npm folder", () => {
	const candidates = codexBinaryCandidates(WHERE_OUTPUT, NPM_ROOT);
	assert.equal(candidates[0], EXPECTED_EXE);
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

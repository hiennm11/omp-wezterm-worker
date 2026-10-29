import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type CommsSettings, checkComms } from "../extensions/lib/comms-check.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { commsNoticeLine } from "../extensions/worker-tools/kit.ts";

const WARN: CommsSettings = { mode: "warn", minScore: 80 };
const ENFORCE: CommsSettings = { mode: "enforce", minScore: 80 };
const OFF: CommsSettings = { mode: "off", minScore: 80 };

const SKILL = join(tmpdir(), "an-ste100-skill-folder");
const CLEAN = "The worker reads the transcript. It reports the result.";

/** The JSON that the skill checker prints for one document. */
function skillJson(score: number, messages: string[] = []): string {
	return JSON.stringify({
		minScore: 80,
		documents: [
			{
				path: "x.md",
				score,
				totalSentences: 2,
				skippedSentences: 0,
				pass: score >= 80,
				findings: messages.map((message, index) => ({
					rule: "UNAPPROVED_WORD",
					message,
					line: index + 1,
					sentence: "s",
				})),
			},
		],
	});
}

interface Call {
	bin: string;
	args: string[];
	cwd?: string;
	text: string | null;
}

/** An exec that records each call and answers like the skill checker. */
function fakeExec(answer: RunResult): { exec: RunFn; calls: Call[] } {
	const calls: Call[] = [];
	const exec: RunFn = async (bin, args, cwd) => {
		const file = args.find((arg) => arg.endsWith(".md"));
		calls.push({ bin, args, cwd, text: file && existsSync(file) ? readFileSync(file, "utf8") : null });
		return answer;
	};
	return { exec, calls };
}

const scored = (score: number, messages: string[] = []): RunResult => ({
	code: score >= 80 ? 0 : 1,
	stdout: skillJson(score, messages),
	stderr: "",
});

test("a text that scores 80 or more passes", async () => {
	const { exec } = fakeExec(scored(93));
	const result = await checkComms(exec, SKILL, CLEAN, "task", WARN);
	assert.equal(result.verdict, "pass");
	assert.equal(result.score, 93);
	assert.deepEqual(result.findings, []);
});

test("a low score warns in the warn mode and fails in the enforce mode", async () => {
	const answer = scored(44, ['Use "supply" instead of "delivered".']);
	const warned = await checkComms(fakeExec(answer).exec, SKILL, CLEAN, "task", WARN);
	const refused = await checkComms(fakeExec(answer).exec, SKILL, CLEAN, "task", ENFORCE);
	assert.equal(warned.verdict, "warn");
	assert.equal(refused.verdict, "fail");
	assert.equal(warned.score, 44);
	assert.equal(refused.findings[0].message, 'Use "supply" instead of "delivered".');
	assert.equal(refused.findings[0].rule, "UNAPPROVED_WORD");
});

test("the result holds the first five findings", async () => {
	const messages = ["a", "b", "c", "d", "e", "f", "g"];
	const result = await checkComms(fakeExec(scored(30, messages)).exec, SKILL, CLEAN, "steer", WARN);
	assert.deepEqual(
		result.findings.map((finding) => finding.message),
		["a", "b", "c", "d", "e"],
	);
});

test("the minimum score of the settings decides the verdict", async () => {
	const { exec } = fakeExec(scored(85));
	const strict = await checkComms(exec, SKILL, CLEAN, "task", { mode: "enforce", minScore: 90 });
	assert.equal(strict.verdict, "fail");
});

test("the skill checker runs with node on a file that holds the text", async () => {
	const { exec, calls } = fakeExec(scored(100));
	await checkComms(exec, SKILL, CLEAN, "task", WARN);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "node");
	assert.equal(calls[0].args[0], join(SKILL, "dist", "cli.js"));
	assert.ok(calls[0].args.includes("--json"));
	assert.equal(calls[0].text, CLEAN);
});

test("the skill checker reads the word list of the repository", async () => {
	const { exec, calls } = fakeExec(scored(100));
	await checkComms(exec, SKILL, CLEAN, "task", WARN);
	const args = calls[0].args;
	const dictionary = args[args.indexOf("--dictionary") + 1];
	assert.ok(dictionary?.endsWith("ste100-dictionary.json"));
	assert.ok(existsSync(dictionary));
});

test("the file of the text is removed after the check", async () => {
	const { exec, calls } = fakeExec(scored(100));
	await checkComms(exec, SKILL, CLEAN, "task", WARN);
	const file = calls[0].args.find((arg) => arg.endsWith(".md"));
	assert.ok(file);
	assert.equal(existsSync(file), false);
});

test("a missing skill gives the verdict skipped with a note, also in the enforce mode", async () => {
	const missing: RunResult = { code: -1, stdout: "", stderr: "Error: spawn node ENOENT" };
	const result = await checkComms(fakeExec(missing).exec, SKILL, CLEAN, "task", ENFORCE);
	assert.equal(result.verdict, "skipped");
	assert.match(result.note ?? "", /ste100/i);
	assert.match(result.note ?? "", new RegExp(SKILL.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
});

test("an exit code 2 or an output that is not JSON gives the verdict skipped", async () => {
	const wrongCommand: RunResult = { code: 2, stdout: "", stderr: "Usage: ste100" };
	const notJson: RunResult = { code: 0, stdout: "STE100 check.", stderr: "" };
	for (const answer of [wrongCommand, notJson]) {
		const result = await checkComms(fakeExec(answer).exec, SKILL, CLEAN, "task", ENFORCE);
		assert.equal(result.verdict, "skipped");
		assert.ok(result.note);
	}
});

test("an exec that throws gives the verdict skipped", async () => {
	const exec: RunFn = async () => {
		throw new Error("boom");
	};
	const result = await checkComms(exec, SKILL, CLEAN, "task", ENFORCE);
	assert.equal(result.verdict, "skipped");
	assert.ok(result.note);
});

test("a Vietnamese text, a short text and the off mode never start the checker", async () => {
	const { exec, calls } = fakeExec(scored(0));
	const vietnamese = await checkComms(
		exec,
		SKILL,
		"Hãy đọc tệp nguồn và liệt kê mọi hàm được xuất ra.",
		"task",
		WARN,
	);
	const short = await checkComms(exec, SKILL, "go now", "steer", WARN);
	const off = await checkComms(exec, SKILL, CLEAN, "task", OFF);
	assert.equal(vietnamese.verdict, "skipped");
	assert.equal(short.verdict, "skipped");
	assert.equal(off.verdict, "off");
	assert.equal(vietnamese.note ?? null, null);
	assert.equal(calls.length, 0);
});

test("an English text with a Vietnamese name is checked", async () => {
	const { exec, calls } = fakeExec(scored(50));
	const result = await checkComms(
		exec,
		SKILL,
		"Ask Trần Minh Hiền to review the change. The worker reads the transcript and it reports the result to the main session.",
		"task",
		ENFORCE,
	);
	assert.equal(result.verdict, "fail");
	assert.equal(calls.length, 1);
});

test("the result keeps the channel of the text", async () => {
	const { exec } = fakeExec(scored(100));
	assert.equal((await checkComms(exec, SKILL, CLEAN, "result", WARN)).channel, "result");
});

test("the notice line names a low score, a missing checker and nothing else", async () => {
	const low = await checkComms(fakeExec(scored(44)).exec, SKILL, CLEAN, "task", WARN);
	const pass = await checkComms(fakeExec(scored(95)).exec, SKILL, CLEAN, "task", WARN);
	const gone = await checkComms(
		fakeExec({ code: -1, stdout: "", stderr: "x" }).exec,
		SKILL,
		CLEAN,
		"task",
		WARN,
	);
	const vietnamese = await checkComms(
		fakeExec(scored(0)).exec,
		SKILL,
		"Hãy đọc tệp nguồn của dự án này.",
		"task",
		WARN,
	);
	assert.match(commsNoticeLine(low, WARN) ?? "", /score is 44.*minimum score is 80/);
	assert.match(commsNoticeLine(gone, WARN) ?? "", /Communication check: skipped\./);
	assert.equal(commsNoticeLine(pass, WARN), null);
	assert.equal(commsNoticeLine(vietnamese, WARN), null);
});

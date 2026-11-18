import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeArgv, claudeResumeArgv, claudeTaskPrompt } from "../extensions/lib/claude-session.ts";

const base = {
	sessionId: "sid-1",
	pluginDir: "C:\\state\\sessions\\wz-x\\claude-plugin",
	contractFile: "C:\\state\\sessions\\wz-x\\.claude-contract.md",
	sessionDir: "C:\\state\\sessions\\wz-x",
	model: null,
};

function contractFile(args: string[]): string | undefined {
	const at = args.indexOf("--append-system-prompt-file");
	return at === -1 ? undefined : args[at + 1];
}

test("a new Claude worker gets the path of the contract file", () => {
	assert.equal(contractFile(claudeArgv(base)), base.contractFile);
});

test("a resumed Claude worker gets the path of the contract file", () => {
	const args = claudeResumeArgv(base);
	assert.equal(contractFile(args), base.contractFile);
});

test("the contract never goes into the argv as text", () => {
	assert.equal(claudeArgv(base).includes("--append-system-prompt"), false);
});

test("the argv holds no prompt, so Claude waits for the task from the launch", () => {
	const args = claudeArgv({ ...base, model: "opus" });
	assert.equal(args[args.length - 1], "opus");
	assert.equal(
		args.some((arg) => /[\r\n\t]/.test(arg)),
		false,
	);
	assert.equal(
		args.some((arg) => arg.includes(".claude-task.md")),
		false,
	);
});

test("the task prompt names the task file and holds no line break", () => {
	const taskFile = "C:\\state\\sessions\\wz-x\\.claude-task.md";
	const prompt = claudeTaskPrompt(taskFile);
	assert.ok(prompt.includes(taskFile));
	assert.equal(/[\r\n\t]/.test(prompt), false);
});

test("the session directory is readable by the worker", () => {
	const args = claudeArgv(base);
	assert.equal(args[args.indexOf("--add-dir") + 1], base.sessionDir);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeArgv, claudeResumeArgv } from "../extensions/lib/claude-session.ts";

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
	const args = claudeArgv({
		...base,
		cwd: "D:\\work",
		taskFile: "C:\\state\\sessions\\wz-x\\.claude-task.md",
	});
	assert.equal(contractFile(args), base.contractFile);
});

test("a resumed Claude worker gets the path of the contract file", () => {
	const args = claudeResumeArgv(base);
	assert.equal(contractFile(args), base.contractFile);
});

test("the contract never goes into the argv as text", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", taskFile: null });
	assert.equal(args.includes("--append-system-prompt"), false);
});

test("the prompt names the task file and holds no line break", () => {
	const taskFile = "C:\\state\\sessions\\wz-x\\.claude-task.md";
	const args = claudeArgv({ ...base, cwd: "D:\\work", taskFile });
	const prompt = args[args.length - 1];
	assert.ok(prompt.includes(taskFile));
	assert.equal(
		args.some((arg) => /[\r\n\t]/.test(arg)),
		false,
	);
});

test("the session directory is readable by the worker", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", taskFile: null });
	assert.equal(args[args.indexOf("--add-dir") + 1], base.sessionDir);
});

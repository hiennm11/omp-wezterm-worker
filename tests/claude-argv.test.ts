import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeArgv, claudeResumeArgv } from "../extensions/lib/claude-session.ts";

const base = {
	sessionId: "sid-1",
	pluginDir: "C:\\state\\sessions\\wz-x\\claude-plugin",
	contractFile: "C:\\state\\sessions\\wz-x\\.claude-contract.md",
	model: null,
};

function contractFile(args: string[]): string | undefined {
	const at = args.indexOf("--append-system-prompt-file");
	return at === -1 ? undefined : args[at + 1];
}

test("a new Claude worker gets the path of the contract file", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", task: "do it" });
	assert.equal(contractFile(args), base.contractFile);
});

test("a resumed Claude worker gets the path of the contract file", () => {
	const args = claudeResumeArgv(base);
	assert.equal(contractFile(args), base.contractFile);
});

test("the contract never goes into the argv as text", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", task: "do it" });
	assert.equal(args.includes("--append-system-prompt"), false);
});

test("the task stays the last argument of a new Claude worker", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", task: "do it" });
	assert.equal(args[args.length - 1], "do it");
});

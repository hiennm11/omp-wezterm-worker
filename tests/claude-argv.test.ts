import assert from "node:assert/strict";
import { test } from "node:test";

import { REPORTING_CONTRACT } from "../extensions/lib/bootstrap-prompt.ts";
import { claudeArgv, claudeResumeArgv } from "../extensions/lib/claude-session.ts";

const base = { sessionId: "sid-1", pluginDir: "C:\\state\\sessions\\wz-x\\claude-plugin", model: null };

function appendedPrompt(args: string[]): string | undefined {
	const at = args.indexOf("--append-system-prompt");
	return at === -1 ? undefined : args[at + 1];
}

test("a new Claude worker gets the reporting contract as one argv element", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", task: "do it" });
	assert.equal(appendedPrompt(args), REPORTING_CONTRACT);
});

test("a resumed Claude worker gets the reporting contract again", () => {
	const args = claudeResumeArgv(base);
	assert.equal(appendedPrompt(args), REPORTING_CONTRACT);
});

test("the task stays the last argument of a new Claude worker", () => {
	const args = claudeArgv({ ...base, cwd: "D:\\work", task: "do it" });
	assert.equal(args[args.length - 1], "do it");
});

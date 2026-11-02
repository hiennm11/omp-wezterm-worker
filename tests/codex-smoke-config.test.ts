/**
 * The comparison of the config file of Codex.
 *
 * The app server of Codex writes a trust entry into the config of the user
 * for a folder that the config does not know. The smoke test accepts that
 * write, and it checks that the rest of the file did not change.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	compareConfigText,
	linesWithoutProject,
	projectSectionLines,
} from "../tooling/codex-smoke-config.ts";

/** The config of a user that holds one project. */
const CONFIG = [
	'model = "gpt-6-luna"',
	'approval_policy = "never"',
	"",
	"[projects.'c:\\tmp\\fixture']",
	'trust_level = "trusted"',
	"",
	"[mcp_servers.gitnexus]",
	'command = "gitnexus.cmd"',
	"",
].join("\n");

/** The project of the fixture of the smoke test. */
const FIXTURE = "C:\\tmp\\fixture";

test("the lines of a project hold the header and the trust level", () => {
	const lines = projectSectionLines(CONFIG, FIXTURE);
	assert.deepEqual(lines, ["[projects.'c:\\tmp\\fixture']", 'trust_level = "trusted"']);
});

test("the lines of a project that the config does not name are empty", () => {
	const lines = projectSectionLines(CONFIG, "C:\\tmp\\other");
	assert.deepEqual(lines, []);
});

test("the lines without a project drop the section of that project", () => {
	const lines = linesWithoutProject(CONFIG, FIXTURE);
	assert.ok(!lines.includes("[projects.'c:\\tmp\\fixture']"));
	assert.ok(lines.includes('trust_level = "trusted"') === false);
	assert.ok(lines.includes("[mcp_servers.gitnexus]"));
});

test("the config holds the same text when nothing changed", () => {
	const verdict = compareConfigText(CONFIG, CONFIG, "hash-a", "hash-a", FIXTURE);
	assert.equal(verdict.verdict, "unchanged");
	assert.equal(verdict.addedEntry, null);
	assert.deepEqual(verdict.differences, []);
});

test("the config holds the entry of the fixture when the app server added it", () => {
	const after = `${CONFIG}\n[projects.'c:\\tmp\\codex-smoke-repo-1\\run']\ntrust_level = "trusted"\n`;
	const verdict = compareConfigText(CONFIG, after, "hash-a", "hash-b", "C:\\tmp\\codex-smoke-repo-1\\run");
	assert.equal(verdict.verdict, "trust-entry-added");
	assert.equal(verdict.addedEntry, "[projects.'c:\\tmp\\codex-smoke-repo-1\\run']");
	assert.deepEqual(verdict.differences, []);
});

test("the config holds a change when a line outside the entry changed", () => {
	const after = CONFIG.replace('approval_policy = "never"', 'approval_policy = "untrusted"');
	const verdict = compareConfigText(CONFIG, after, "hash-a", "hash-b", FIXTURE);
	assert.equal(verdict.verdict, "changed");
	assert.match(verdict.differences.join(" "), /outside the entry/);
});

test("the config holds a change when the entry of the fixture is gone", () => {
	const after = CONFIG.replace("[projects.'c:\\tmp\\fixture']\n", "");
	const verdict = compareConfigText(CONFIG, after, "hash-a", "hash-b", FIXTURE);
	assert.equal(verdict.verdict, "changed");
	assert.match(verdict.differences.join(" "), /no entry of the project/);
});

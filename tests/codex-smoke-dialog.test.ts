/**
 * The dialog of a command in the pane of a Codex worker.
 *
 * The TUI of Codex wraps its text to the width of the pane. A narrow pane
 * puts one or two words on each line. The function `showsCommandDialog`
 * must find the dialog in that text.
 *
 * The file of the narrow pane holds the real text of the pane of the smoke
 * run of 2026-11-05. The pane held the dialog of the approval of a command.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../extensions/lib/config.ts";
import { writeSmokeConfig } from "../tooling/codex-smoke-shared.ts";
import { showsCommandDialog } from "../tooling/codex-smoke-steps.ts";

/** The root of the repository. */
const ROOT = join(import.meta.dirname, "..");

/** The real text of a narrow pane that holds the dialog of a command. */
const NARROW_PANE = readFileSync(
	join(ROOT, "tests", "fixtures", "codex-command-dialog-narrow-pane.txt"),
	"utf8",
);

/** The real text of a wide pane that holds the dialog of a command. */
const WIDE_PANE = readFileSync(join(ROOT, "tests", "fixtures", "codex-command-dialog-pane.txt"), "utf8");

/** The real text of a pane that holds the approval dialog of the report server. */
const MCP_PANE = readFileSync(join(ROOT, "tests", "fixtures", "codex-approval-pane.txt"), "utf8");

/** The text of a pane that holds the screen of a worker without a dialog. */
const NO_DIALOG = [
	"  >_ OpenAI Codex (v0.166.0)",
	"     ~\\AppData\\Local\\Temp\\codex-smoke-repo-Z9Ij84\\run",
	"",
	"  To get started, describe a task or try one of these commands:",
	"",
	"  /init - create an AGENTS.md file with instructions for Codex",
	"  /status - show current session configuration",
	"  /permissions - choose what Codex is allowed to do",
	"",
	"› Run a shell command that writes APPROVED to approval.txt.",
	"• I'll run the requested shell command in the workspace.",
].join("\n");

test("the dialog is found in a narrow pane that wraps its text", () => {
	assert.equal(showsCommandDialog(NARROW_PANE), true);
});

test("the dialog is found in a wide pane", () => {
	assert.equal(showsCommandDialog(WIDE_PANE), true);
});

test("a pane without a dialog shows no dialog", () => {
	assert.equal(showsCommandDialog(NO_DIALOG), false);
});

test("an empty pane shows no dialog", () => {
	assert.equal(showsCommandDialog(""), false);
});

test("the dialog of the report server is not the dialog of a command", () => {
	assert.equal(showsCommandDialog(MCP_PANE), false);
});

test("the config file of the smoke names no policy of the approval", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-smoke-config-"));
	writeSmokeConfig(dir);
	const file = join(dir, "wezterm-worker.json");
	const config = loadConfig(file, {});
	assert.equal(config.codexApprovalPolicy, null);
});

test("the config file of the smoke holds only the two limits", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-smoke-config-"));
	writeSmokeConfig(dir);
	const file = join(dir, "wezterm-worker.json");
	const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(raw).sort(), ["maxActiveWorkers", "maxLaunchesPerRequest"]);
});

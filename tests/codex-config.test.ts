/**
 * A config file that still holds the settings of the Codex backend.
 *
 * The Codex backend was removed. A config file of an older release must not
 * crash the extension. The loader gives one guidance line that names the
 * ignored key.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { lastGuidance, loadConfig } from "../extensions/lib/config.ts";

/** Write a config file and return its path. */
function configFile(content: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-config-"));
	const file = join(dir, "wezterm-worker.json");
	writeFileSync(file, JSON.stringify(content), "utf8");
	return file;
}

test("a config file with codexBin gives guidance that names the key", () => {
	const file = configFile({ codexBin: "/opt/codex" });
	loadConfig(file, {});
	const guidance = lastGuidance ?? "";
	assert.match(guidance, /codexBin/);
	assert.match(guidance, /Codex backend was removed/);
});

test("a config file with a codex section gives guidance that names the key", () => {
	const file = configFile({ codex: { approvalPolicy: "untrusted" } });
	loadConfig(file, {});
	const guidance = lastGuidance ?? "";
	assert.match(guidance, /codex/);
	assert.match(guidance, /Codex backend was removed/);
});

test("a config file with codexBin and a codex section gives one guidance line", () => {
	const file = configFile({ codexBin: "/opt/codex", codex: { approvalPolicy: "never" } });
	loadConfig(file, {});
	const guidance = lastGuidance ?? "";
	assert.equal(guidance.split("\n").length, 1);
	assert.match(guidance, /codexBin/);
	assert.match(guidance, /codex/);
});

test("a config file without the Codex settings gives no guidance", () => {
	const file = configFile({ ompBin: "omp" });
	loadConfig(file, {});
	assert.equal(lastGuidance, null);
});

test("a config file with the Codex settings still loads the other values", () => {
	const file = configFile({ codexBin: "/opt/codex", ompBin: "/opt/omp" });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.ompBin, "/opt/omp");
});

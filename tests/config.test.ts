import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, lastGuidance, loadConfig, readCommsStandard } from "../extensions/lib/config.ts";

/** Write a config file and return its path. */
function configFile(content: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-config-"));
	const file = join(dir, "wezterm-worker.json");
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
	return file;
}

test("a missing config file leaves the defaults", () => {
	const cfg = loadConfig(join(tmpdir(), `no-such-config-${Date.now()}.json`), {});
	assert.equal(cfg.ompBin, DEFAULT_CONFIG.ompBin);
	assert.equal(cfg.weztermBin, DEFAULT_CONFIG.weztermBin);
	assert.equal(cfg.placement, DEFAULT_CONFIG.placement);
	assert.equal(cfg.closePaneOnFinish, DEFAULT_CONFIG.closePaneOnFinish);
});

test("the file overrides the defaults", () => {
	const file = configFile({
		ompBin: "/opt/omp",
		weztermBin: "/opt/wezterm",
		placement: "tab",
		stateDir: "/tmp/state",
		defaultCwd: "/tmp/work",
		model: "some/model",
		tools: ["read", "grep"],
		pollMs: 500,
		timeoutMs: 1000,
		idleTimeoutMs: 0,
		isolated: true,
		closePaneOnFinish: false,
		maxActiveWorkers: 4,
		maxLaunchesPerRequest: 9,
	});
	const cfg = loadConfig(file, {});
	assert.equal(cfg.ompBin, "/opt/omp");
	assert.equal(cfg.weztermBin, "/opt/wezterm");
	assert.equal(cfg.placement, "tab");
	assert.equal(cfg.stateDir, "/tmp/state");
	assert.equal(cfg.defaultCwd, "/tmp/work");
	assert.equal(cfg.model, "some/model");
	assert.deepEqual(cfg.tools, ["read", "grep"]);
	assert.equal(cfg.pollMs, 500);
	assert.equal(cfg.timeoutMs, 1000);
	assert.equal(cfg.idleTimeoutMs, 0);
	assert.equal(cfg.isolated, true);
	assert.equal(cfg.closePaneOnFinish, false);
	assert.equal(cfg.maxActiveWorkers, 4);
	assert.equal(cfg.maxLaunchesPerRequest, 9);
});

test("the environment variable names the config file", () => {
	const file = configFile({ maxActiveWorkers: 7 });
	const cfg = loadConfig(undefined, { OMP_WORKER_CONFIG_FILE: file });
	assert.equal(cfg.maxActiveWorkers, 7);
});

test("a file argument wins over the environment variable", () => {
	const file = configFile({ maxActiveWorkers: 7 });
	const other = configFile({ maxActiveWorkers: 5 });
	const cfg = loadConfig(other, { OMP_WORKER_CONFIG_FILE: file });
	assert.equal(cfg.maxActiveWorkers, 5);
});

test("the environment wins over the file", () => {
	const file = configFile({ ompBin: "/from/file", stateDir: "/from/file" });
	const cfg = loadConfig(file, {
		OMP_WORKER_OMP_BIN: "/from/env",
		OMP_WORKER_STATE_DIR: "/from/env/state",
	});
	assert.equal(cfg.ompBin, "/from/env");
	assert.equal(cfg.stateDir, "/from/env/state");
});

test("a value of the wrong type leaves the default", () => {
	const file = configFile({ ompBin: 42, pollMs: "fast", isolated: "yes", placement: "window" });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.ompBin, DEFAULT_CONFIG.ompBin);
	assert.equal(cfg.pollMs, DEFAULT_CONFIG.pollMs);
	assert.equal(cfg.isolated, DEFAULT_CONFIG.isolated);
	assert.equal(cfg.placement, DEFAULT_CONFIG.placement);
});

test("a malformed file leaves the defaults", () => {
	const file = configFile("{not json");
	const cfg = loadConfig(file, {});
	assert.equal(cfg.ompBin, DEFAULT_CONFIG.ompBin);
	assert.equal(cfg.placement, DEFAULT_CONFIG.placement);
});

test("the tools list is a list of strings", () => {
	const file = configFile({ tools: ["read", 7, true] });
	const cfg = loadConfig(file, {});
	assert.deepEqual(cfg.tools, ["read", "7", "true"]);
});

test("a nonzero idle deadline is refused with guidance", () => {
	const file = configFile({ idleTimeoutMs: 2000 });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.idleTimeoutMs, 0, "the idle deadline does not run");
	assert.match(lastGuidance ?? "", /idleTimeoutMs is gone/);
});

test("a zero idle deadline gives no guidance", () => {
	const file = configFile({ idleTimeoutMs: 0 });
	loadConfig(file, {});
	assert.equal(lastGuidance, null);
});

test("a score outside the range is refused with guidance", () => {
	const high = configFile({ commsStandard: { mode: "enforce", minScore: 150 } });
	const highCfg = loadConfig(high, {});
	assert.equal(highCfg.commsStandard.minScore, 80);
	assert.equal(highCfg.commsStandard.mode, "enforce");
	assert.match(lastGuidance ?? "", /minScore/);
	const low = configFile({ commsStandard: { minScore: -1 } });
	const lowCfg = loadConfig(low, {});
	assert.equal(lowCfg.commsStandard.minScore, 80);
	assert.match(lastGuidance ?? "", /minScore/);
});

test("the settings function refuses a score outside the range", () => {
	const guidance: string[] = [];
	const settings = readCommsStandard({ mode: "enforce", minScore: 150 }, guidance);
	assert.equal(settings.minScore, 80);
	assert.equal(settings.mode, "enforce");
	assert.equal(guidance.length, 1);
	assert.match(guidance[0], /minScore/);
});

test("the settings function keeps a wrong mode and a wrong score type", () => {
	const guidance: string[] = [];
	const settings = readCommsStandard({ mode: "loud", minScore: "80" }, guidance);
	assert.equal(settings.mode, DEFAULT_CONFIG.commsStandard.mode);
	assert.equal(settings.minScore, DEFAULT_CONFIG.commsStandard.minScore);
	assert.deepEqual(guidance, []);
});

test("two problems in one file give both guidance messages", () => {
	const file = configFile({ idleTimeoutMs: 2000, commsStandard: { minScore: 150 } });
	loadConfig(file, {});
	const guidance = lastGuidance ?? "";
	assert.match(guidance, /idleTimeoutMs is gone/);
	assert.match(guidance, /minScore/);
});

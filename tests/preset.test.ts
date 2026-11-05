import assert from "node:assert/strict";
import { test } from "node:test";
import type { Preset } from "../extensions/lib/preset.ts";
import { readPresets, resolveSpawn, withReportTool } from "../extensions/lib/preset.ts";

const preset: Preset = {
	model: "preset-model",
	tools: ["read"],
	thinking: "low",
	isolated: true,
	backend: "omp",
};

test("spawn parameters win over every preset field", () => {
	const params = {
		model: "call-model",
		tools: ["grep"],
		thinking: "high",
		isolated: false,
		backend: "codex",
	};
	assert.deepEqual(resolveSpawn({ scout: preset }, "scout", params), { ...params });
});

test("preset values fill fields omitted by the call", () => {
	assert.deepEqual(resolveSpawn({ scout: preset }, "scout", {}), { ...preset });
});

test("an empty call tool list wins over preset tools", () => {
	assert.deepEqual(resolveSpawn({ scout: preset }, "scout", { tools: [] }), { ...preset, tools: [] });
});

test("an unknown preset refusal lists existing names in stable order", () => {
	assert.equal(
		resolveSpawn({ task: preset, plan: preset }, "missing", {}),
		"Unknown preset 'missing'. Use one of: plan, task.",
	);
});

test("prototype property names cannot resolve as presets", () => {
	for (const name of ["constructor", "__proto__"]) {
		assert.match(String(resolveSpawn({}, name, {})), /Unknown preset/);
	}
});

test("invalid presets are skipped with guidance while valid presets load", () => {
	const guidance: string[] = [];
	const presets = readPresets(
		{
			good: { model: "valid" },
			badType: { tools: "read" },
			badKey: { thinkng: "low" },
			"": { model: "empty" },
		},
		guidance,
	);
	assert.deepEqual(presets.good, { model: "valid" });
	assert.equal(Object.keys(presets).length, 1);
	assert.equal(guidance.length, 3);
	assert.match(guidance.join(" "), /badType.*tools/);
	assert.match(guidance.join(" "), /badKey.*thinkng/);
	assert.match(guidance.join(" "), /empty/);
});

test("withReportTool adds once and preserves null, empty, and input values", () => {
	const tools = ["read"];
	assert.deepEqual(withReportTool(tools), ["read", "wezterm_worker_report"]);
	assert.deepEqual(tools, ["read"]);
	const existing = ["read", "wezterm_worker_report"];
	assert.equal(withReportTool(existing), existing);
	assert.equal(withReportTool(null), null);
	const empty: string[] = [];
	assert.equal(withReportTool(empty), empty);
});

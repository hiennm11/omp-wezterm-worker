import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";

const CONTEXT = {
	cwd: process.cwd(),
	sessionManager: { getSessionFile: () => null, getSessionId: () => null },
};

function spawnToolOf(rt: WorkerRuntime) {
	const tools = new Map<
		string,
		{ execute: (id: string, params: Record<string, unknown>, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }
	>();
	const chain = { optional: () => chain, describe: () => chain };
	registerSpawnTool({
		pi: {
			zod: { string: () => chain, number: () => chain, boolean: () => chain, array: () => chain, object: () => chain },
			registerTool: (tool: { name: string; execute: unknown }) => tools.set(tool.name, tool as never),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("wezterm_spawn_worker");
	assert.ok(tool);
	return tool;
}

function runtime() {
	const dir = mkdtempSync(join(tmpdir(), "wt-preset-"));
	const calls: string[][] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push([bin, ...args]);
		if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
		if (args.includes("split-pane") || args.includes("spawn")) return { code: 0, stdout: "99", stderr: "" };
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.presets = { scout: { model: "preset-model", tools: ["read", "grep", "glob"] } };
	return { rt, dir, calls };
}

test("preset values start an OMP worker and call values override them", async () => {
	const { rt, dir, calls } = runtime();
	try {
		const tool = spawnToolOf(rt);
		for (const model of ["preset-model", "other"]) {
			const result = await tool.execute("t1", { task: "Read baseline.txt.", cwd: dir, preset: "scout", ...(model === "other" ? { model } : {}) }, undefined, undefined, CONTEXT);
			assert.notEqual(result.isError, true, result.content[0]?.text);
			const command = calls.find((args) => args.includes("--tools"));
			assert.ok(command, "the OMP pane command did not include --tools");
			const toolsAt = command.indexOf("--tools");
			assert.equal(command[toolsAt + 1], "read,grep,glob,wezterm_worker_report");
			const modelAt = command.indexOf("--model");
			assert.equal(command[modelAt + 1], model);
			calls.splice(0, calls.length);
		}
		const missing = await tool.execute("t1", { task: "Read baseline.txt.", cwd: dir, preset: "missing" }, undefined, undefined, CONTEXT);
		assert.equal(missing.isError, true);
		assert.match(missing.content[0]?.text ?? "", /scout/);
		assert.equal(calls.some((args) => args.includes("split-pane") || args.includes("spawn")), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a preset with Claude backend and tools uses the existing tools refusal", async () => {
	const { rt, dir } = runtime();
	try {
		rt.config.presets.claude = { backend: "claude", tools: ["read"] };
		const tool = spawnToolOf(rt);
		const result = await tool.execute("t1", { task: "Read baseline.txt.", cwd: dir, preset: "claude" }, undefined, undefined, CONTEXT);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /tools parameter applies to an OMP worker only/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

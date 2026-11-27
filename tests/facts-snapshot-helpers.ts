/**
 * The helpers of the tests of the snapshot of the facts.
 *
 * The tests need a runtime with a fake pane and a promoted store of facts.
 * The helpers live here, so the test files do not copy them.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendPromotedFact } from "../extensions/lib/facts-store.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerSpawnTool } from "../extensions/worker-tools/spawn.ts";
import { deliveryTracker, reportPromptSubmit } from "./delivery-helpers.ts";

/** The identity of the session that promotes the facts. */
export const SESSION = "session-1";

/** The context of a call of the spawn tool. */
export const CONTEXT = {
	cwd: process.cwd(),
	sessionManager: { getSessionFile: () => null, getSessionId: () => SESSION },
};

/** The spawn tool of a runtime. */
export interface SpawnTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		update?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** The spawn tool of a runtime. The tool registers itself with a fake host. */
export function spawnToolOf(rt: WorkerRuntime): SpawnTool {
	const tools = new Map<string, SpawnTool>();
	const chain = { optional: () => chain, describe: () => chain };
	registerSpawnTool({
		pi: {
			zod: {
				string: () => chain,
				number: () => chain,
				boolean: () => chain,
				array: () => chain,
				object: () => chain,
			},
			registerTool: (tool: { name: string; execute: unknown }) => tools.set(tool.name, tool as never),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("wezterm_spawn_worker");
	assert.ok(tool, "the spawn tool was not registered");
	return tool;
}

/**
 * A runtime with a pane runtime and a fresh state directory.
 *
 * The fake pane answers every call of a launch, so the spawn reaches a
 * running worker.
 */
export function fakeRuntime(): { rt: WorkerRuntime; dir: string; calls: string[][] } {
	const dir = mkdtempSync(join(tmpdir(), "wt-facts-snapshot-"));
	const calls: string[][] = [];
	const tracker = deliveryTracker();
	const exec: RunFn = async (_bin, args) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "list") {
			return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "split") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p99", tab_id: "w1:t1" } } }),
				stderr: "",
			};
		}
		if (args[0] === "tab" && args[1] === "create") {
			return {
				code: 0,
				stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p99", tab_id: "w1:t2" } } }),
				stderr: "",
			};
		}
		if (args[0] === "agent" && args[1] === "start") {
			tracker.onStart(args);
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (args[0] === "agent" && args[1] === "prompt") {
			tracker.onPrompt();
			reportPromptSubmit(rt, args[3] ?? "");
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "read") {
			return { code: 0, stdout: "bypass permissions on", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.runtime = "herdr";
	rt.config.commsStandard = { mode: "off", minScore: 80 };
	rt.sessionId = SESSION;
	return { rt, dir, calls };
}

/** The session directory of a worker, read from the reply of a spawn. */
export function sessionDirOf(details: Record<string, unknown>): string {
	const dir = details.transcriptDir;
	assert.equal(typeof dir, "string", "the reply names no session directory");
	return dir as string;
}

/** True when a call opened a pane. */
export function openedPane(calls: string[][]): boolean {
	return calls.some(
		(args) => (args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"),
	);
}

/** Promote a fact of the main session. */
export function promote(dir: string, key: string, text: string): void {
	appendPromotedFact(dir, SESSION, { key, text, writer: SESSION, at: 100 });
}

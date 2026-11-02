/**
 * The helpers of the tests of the mixed backends.
 *
 * A mixed test holds workers of the OMP backend, of the Claude Code backend
 * and of the Codex backend in one runtime. The helpers give every test the
 * tools of the extension, a way to start a worker of every backend and a way
 * to read the reply of a tool. The programs and the panes are the only
 * fakes. Every other part is the code of the extension.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import type { ToolDeps } from "../extensions/worker-tools/kit.ts";

import type { MixedMachine } from "./mixed-machine.ts";

export { type HostOptions, type MixedMachine, mixedMachine } from "./mixed-machine.ts";
export { flush } from "./reattach-native-helpers.ts";

/** The task that every worker of the tests receives. */
export const TASK = "Do the work of the task and report the result.";

/** A tool that the fake host records. */
export interface FakeTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A tool as the extension registers it. The host gives five arguments. */
interface RegisteredTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
}

/** A zod stub that accepts every parameter object. */
export function fakeZod(): never {
	const chain = {
		optional: () => chain,
		describe: () => chain,
	};
	return {
		string: () => chain,
		number: () => chain,
		boolean: () => chain,
		array: () => chain,
		object: () => chain,
	} as never;
}

/**
 * The tool that the extension registers.
 *
 * The wrapper puts the context of the call where the tool reads it, so a
 * tool that needs the session of the caller gets it.
 */
export function toolOf(rt: WorkerRuntime, register: (deps: ToolDeps) => void, name: string): FakeTool {
	const tools = new Map<string, FakeTool>();
	register({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: RegisteredTool) => {
				tools.set(name, {
					execute: (id, params, ctx) => tool.execute(id, params, undefined, undefined, ctx),
				});
			},
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get(name);
	assert.ok(tool, `the ${name} tool was not registered`);
	return tool;
}

/** The context that a tool of the extension receives. */
export function toolCtx(cwd: string, sessionId: string): unknown {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null },
	};
}

/** Start a Claude Code worker in the fake machine. */
export async function startClaude(machine: MixedMachine, id: string) {
	return spawnClaudeWorker(machine.rt, {
		jobId: id,
		task: TASK,
		cwd: machine.dir,
		sessionId: `sess-${id}`,
	});
}

/** Start a Codex worker in the fake machine. */
export async function startCodex(machine: MixedMachine, id: string) {
	return spawnCodexWorker(
		machine.rt,
		{ jobId: id, task: TASK, cwd: machine.dir },
		{ connect: machine.connect, serverWaitMs: 200 },
	);
}

/** Write a transcript that holds a call that never settles. */
export function writeOpenCallTranscript(job: { sessionDir: string }): string {
	mkdirSync(job.sessionDir, { recursive: true });
	const file = join(job.sessionDir, "session.jsonl");
	const line = JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] },
	});
	writeFileSync(file, `${line}\n`, "utf8");
	return file;
}

/** The text of a tool reply. */
export function replyText(result: { content: { text: string }[] }): string {
	return result.content[0]?.text ?? "";
}

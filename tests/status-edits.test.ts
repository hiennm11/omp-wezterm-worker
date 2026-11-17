/**
 * The line of the status tool that counts the file changes of a worker.
 *
 * Only an OMP worker shows the line. A Claude worker has no count, and a
 * worker with no transcript that the owner can read shows no line.
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { observeTranscript } from "../extensions/lib/monitor.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { cleanup, fakeRuntime, makeDirs, nativeJob } from "./reattach-native-helpers.ts";

interface FakeTool {
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

function fakeZod(): never {
	const chain = { optional: () => chain, describe: () => chain };
	return { string: () => chain, number: () => chain, object: () => chain } as never;
}

async function statusText(rt: WorkerRuntime): Promise<string> {
	const tools = new Map<string, FakeTool>();
	registerStatusTool({
		pi: { zod: fakeZod(), registerTool: (tool: FakeTool) => tools.set("status", tool) } as never,
		rt,
		deliver: () => undefined,
	});
	const result = await tools.get("status")?.execute("t1", {});
	return result?.content[0]?.text ?? "";
}

test("an OMP worker shows the count of the file changes", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, ["w1:p7"]);
	try {
		const job = nativeJob(sessionDir, { backend: "omp", editCalls: 3, turns: 47 });
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.match(text, /changes\s+: 3 edit call\(s\) in 47 turns/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("an OMP worker without a change shows zero", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, ["w1:p7"]);
	try {
		const job = nativeJob(sessionDir, { backend: "omp", editCalls: 0, turns: 47 });
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.match(text, /changes\s+: 0 edit call\(s\) in 47 turns/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("a worker without a count shows no line", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, ["w1:p7"]);
	try {
		const job = nativeJob(sessionDir, { backend: "omp", turns: 47 });
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.doesNotMatch(text, /changes\s+:/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("a Claude worker shows no line", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, ["w1:p7"]);
	try {
		const job = nativeJob(sessionDir, { backend: "claude", editCalls: 3, turns: 47 });
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.doesNotMatch(text, /changes\s+:/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("a run of the removed backend shows no line", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, ["w1:p7"]);
	try {
		const job = nativeJob(sessionDir, {
			backend: "codex" as never,
			status: "completed",
			editCalls: 3,
			turns: 47,
		});
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.doesNotMatch(text, /changes\s+:/);
	} finally {
		await cleanup(rt, dir);
	}
});

/** Write a transcript with the given tool calls into a session directory. */
function writeTranscript(sessionDir: string, tools: string[]): void {
	const content = tools.map((name) => ({ type: "toolCall", name, id: `call_${name}` }));
	const line = JSON.stringify({ type: "message", message: { role: "assistant", content } });
	writeFileSync(join(sessionDir, "a.jsonl"), `${line}\n`, "utf8");
}

test("the status tool reads the count from the transcript of a running worker", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, ["w1:p7"]);
	try {
		writeTranscript(sessionDir, ["edit", "write", "read"]);
		const job = nativeJob(sessionDir, { backend: "omp", turns: 0 });
		rt.jobs.set(job.id, job);
		const text = await statusText(rt);
		assert.match(text, /changes\s+: 2 edit call\(s\) in 1 turns/);
	} finally {
		await cleanup(rt, dir);
	}
});

test("the monitor poll copies the count from the transcript to the job", () => {
	const { dir, sessionDir } = makeDirs();
	try {
		writeTranscript(sessionDir, ["edit", "ast_edit", "bash"]);
		const job = nativeJob(sessionDir, { backend: "omp", turns: 0 });
		observeTranscript(job, Date.now());
		assert.equal(job.editCalls, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

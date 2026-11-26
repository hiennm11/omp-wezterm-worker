/**
 * The report of the prune.
 *
 * The report names every worker that needs a decision. It does not name a
 * worker that the prune cannot act on. It counts the workers that it skips.
 *
 * The tests use a real git repository, a real worktree and the real git
 * commands. They start no pane.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { registerPruneTool } from "../extensions/worker-tools/prune.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import {
	addWorker,
	addWorklessWorker,
	applyWorkerCommits,
	branchExists,
	finish,
	pruneFixture,
	toolOf,
} from "./prune-helpers.ts";

/** The prune tool of the extension, with the given runtime. */
function pruneTool(rt: WorkerRuntime) {
	return toolOf(rt, registerPruneTool, "wezterm_worker_prune");
}

/** The lines of the text of a reply. */
function textLines(text: string): string[] {
	return text.split("\n").filter((line) => line.length > 0);
}

/** The lines of the reply that name a worker. */
function workerLines(text: string): string[] {
	return textLines(text).filter((line) => line.startsWith("- "));
}

/** The lines of the reply that count the workers that the report skips. */
function summaryLines(text: string): string[] {
	return textLines(text).filter((line) => /skipped/.test(line));
}

/** The ids of the workers that a reply names. */
function workerIds(text: string): string[] {
	return workerLines(text).map((line) => line.slice(2).split(":")[0] ?? "");
}

test("the report names the workers that need a decision and counts the workers that it skips", async () => {
	const fixture = await pruneFixture();
	try {
		await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");
		await addWorker(fixture, { id: "wz-2", commits: ["feature"], uncommitted: true });
		await applyWorkerCommits(fixture, "wz-2");
		await addWorker(fixture, { id: "wz-3", commits: ["feature"] });
		for (let index = 0; index < 200; index += 1) {
			addWorklessWorker(fixture, `old-${index}`);
		}

		const result = await pruneTool(fixture.rt).execute("t1", {});
		const text = result.content[0]?.text ?? "";

		assert.equal(workerLines(text).length, 3, "the report names a worker that it skips");
		assert.equal(summaryLines(text).length, 1, "the report has no line that counts the skipped workers");
		assert.match(summaryLines(text)[0] ?? "", /200 workers have no worktree/);
	} finally {
		finish(fixture);
	}
});

test("the report names a worker with uncommitted changes and the count of the changes", async () => {
	const fixture = await pruneFixture();
	try {
		await addWorker(fixture, { id: "wz-1", commits: ["feature"], uncommitted: true });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", {});
		const text = result.content[0]?.text ?? "";

		const line = workerLines(text).find((entry) => entry.includes("wz-1"));
		assert.ok(line, "the report does not name the worker with uncommitted changes");
		assert.match(line, /uncommitted changes \(1\)/);
	} finally {
		finish(fixture);
	}
});

test("the report has no line that counts the skipped workers when no worker is skipped", async () => {
	const fixture = await pruneFixture();
	try {
		await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", {});
		const text = result.content[0]?.text ?? "";

		assert.equal(workerLines(text).length, 1);
		assert.equal(summaryLines(text).length, 0);
	} finally {
		finish(fixture);
	}
});

test("a dry run and a real run name the same workers and a real run removes the worktree", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");
		addWorklessWorker(fixture, "old-1");

		const tool = pruneTool(fixture.rt);
		const dry = await tool.execute("t1", {});
		const real = await tool.execute("t2", { dryRun: false });

		assert.deepEqual(workerIds(real.content[0]?.text ?? ""), workerIds(dry.content[0]?.text ?? ""));
		assert.equal(existsSync(job.worktreePath ?? ""), false, "the real run kept the worktree");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), false, "the real run kept the branch");
	} finally {
		finish(fixture);
	}
});

/**
 * The prune of the old workers.
 *
 * The tests use a real git repository, a real worktree and the real git
 * commands. They start no pane. A test sees what a user sees: the worktree
 * of the worker is gone or it is still there, and the branch of the worker
 * is gone or it is still there.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { registerPruneTool } from "../extensions/worker-tools/prune.ts";
import {
	addWorker,
	applyWorkerCommits,
	branchExists,
	finish,
	git,
	itemsOf,
	pruneFixture,
	seedEvent,
	toolOf,
} from "./prune-helpers.ts";

/** The prune tool of the extension, with the given runtime. */
function pruneTool(rt: import("../extensions/lib/runtime.ts").WorkerRuntime) {
	return toolOf(rt, registerPruneTool, "wezterm_worker_prune");
}

/** The worker of a list of the report. */
function workerOf(list: unknown, workerId: string): { workerId: string; reason: string } {
	const item = itemsOf(list).find((entry) => entry.workerId === workerId);
	assert.ok(item, `the report has no worker ${workerId}`);
	return item;
}

test("a dry run changes nothing and lists the worker that a real run removes", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", {});
		const details = result.details;

		assert.equal(details.dryRun, true);
		assert.equal(itemsOf(details.wouldRemove).length, 1);
		assert.equal(itemsOf(details.wouldRemove)[0]?.workerId, "wz-1");
		assert.equal(itemsOf(details.removed).length, 0);
		assert.equal(itemsOf(details.kept).length, 0);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the dry run removed the worktree");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the dry run removed the branch");
	} finally {
		finish(fixture);
	}
});

test("a worker whose commits were rebased into the target loses its worktree and its branch", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 1);
		assert.equal(itemsOf(details.removed)[0]?.workerId, "wz-1");
		assert.equal(itemsOf(details.kept).length, 0);
		assert.equal(existsSync(job.worktreePath ?? ""), false, "the worktree is still there");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), false, "the branch is still there");
	} finally {
		finish(fixture);
	}
});

test("a worker with a commit that the target does not hold keeps its worktree and its branch", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		assert.equal(itemsOf(details.wouldRemove).length, 0);
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /not in/);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

test("a worker with an uncommitted file keeps its worktree and its branch", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, {
			id: "wz-1",
			commits: ["feature"],
			uncommitted: true,
		});
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /uncommitted/);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

test("a worker whose worktree is gone from the disk is kept and the reason names the worktree", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");
		rmSync(job.worktreePath ?? "", { recursive: true, force: true });

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /worktree is gone/);
		assert.doesNotMatch(kept.reason, /stash/);
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

test("a dry run does not list a worker with an uncommitted file", async () => {
	const fixture = await pruneFixture();
	try {
		await addWorker(fixture, { id: "wz-1", commits: ["feature"], uncommitted: true });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", {});
		const details = result.details;

		assert.equal(itemsOf(details.wouldRemove).length, 0, "a dirty worktree is on the list of the dry run");
		assert.match(workerOf(details.kept, "wz-1").reason, /uncommitted/);
	} finally {
		finish(fixture);
	}
});

test("a worker that still runs keeps its worktree and its branch", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");
		/* A running worker can keep the end time of an earlier run. */
		job.status = "running";

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		assert.equal(itemsOf(details.wouldRemove).length, 0);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree of a running worker was removed");
		assert.equal(
			await branchExists(fixture.repo, "omp/worker/wz-1"),
			true,
			"the branch of a running worker was removed",
		);
	} finally {
		finish(fixture);
	}
});

test("a worker with a stash keeps its worktree and its branch", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");
		writeFileSync(join(job.worktreePath ?? "", "stashed.txt"), "stashed\n", "utf8");
		await git(job.worktreePath ?? "", ["stash", "push", "-u"]);

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /stash/);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

test("a worker that is younger than olderThanDays is kept", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"], finishedDaysAgo: 2 });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /younger/);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

test("a worker that holds a pending event is kept and the other workers go", async () => {
	const fixture = await pruneFixture();
	try {
		const blocked = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		const free = await addWorker(fixture, { id: "wz-2", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");
		await applyWorkerCommits(fixture, "wz-2");
		seedEvent(fixture.rt, "wz-1", "ev-1");

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 1);
		assert.equal(itemsOf(details.removed)[0]?.workerId, "wz-2");
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /unhandled event/);
		assert.equal(existsSync(blocked.worktreePath ?? ""), true, "the worktree of wz-1 was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch of wz-1 was removed");
		assert.equal(existsSync(free.worktreePath ?? ""), false, "the worktree of wz-2 is still there");
		assert.equal(
			await branchExists(fixture.repo, "omp/worker/wz-2"),
			false,
			"the branch of wz-2 is still there",
		);
	} finally {
		finish(fixture);
	}
});

test("a worker without a default branch and without into is kept and the message names into", async () => {
	const fixture = await pruneFixture({ defaultBranch: false });
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 0);
		const kept = workerOf(details.kept, "wz-1");
		assert.match(kept.reason, /into/);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

test("a worker goes when the branch that into names holds its work", async () => {
	const fixture = await pruneFixture({ defaultBranch: false });
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false, into: "origin/main" });
		const details = result.details;

		assert.equal(itemsOf(details.removed).length, 1);
		assert.equal(itemsOf(details.removed)[0]?.workerId, "wz-1");
		assert.equal(existsSync(job.worktreePath ?? ""), false, "the worktree is still there");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), false, "the branch is still there");
	} finally {
		finish(fixture);
	}
});

test("a subagent cannot prune", async () => {
	const fixture = await pruneFixture();
	try {
		const job = await addWorker(fixture, { id: "wz-1", commits: ["feature"] });
		await applyWorkerCommits(fixture, "wz-1");

		const result = await pruneTool(fixture.rt).execute("t1", { dryRun: false }, undefined, undefined, {
			agent: { kind: "sub", id: "sub-1", depth: 1 },
		});

		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"A subagent cannot control a worker. Call this tool from the main session.",
		);
		assert.equal(existsSync(job.worktreePath ?? ""), true, "the worktree was removed");
		assert.equal(await branchExists(fixture.repo, "omp/worker/wz-1"), true, "the branch was removed");
	} finally {
		finish(fixture);
	}
});

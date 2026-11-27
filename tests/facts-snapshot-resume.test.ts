/**
 * The snapshot of the facts in a resume and in a contract.
 *
 * A resume shares the session directory of its source run. The snapshot
 * lives in that directory, so a resume keeps it. The contract of a worker
 * holds the snapshot of its session directory.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { REPORTING_CONTRACT, writeClaudeContract } from "../extensions/lib/bootstrap-prompt.ts";
import { factsSnapshotFile } from "../extensions/lib/facts-snapshot.ts";
import { createGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import { fakeRuntime } from "./facts-snapshot-helpers.ts";

/** The text of a snapshot of a fact. */
const SNAPSHOT_TEXT = "# The facts\n\nbuild: The build fails on Windows.\n";

/** A source run that a resume acts on. */
function sourceJob(dir: string, id: string, overrides: Partial<Job> = {}): Job {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return {
		id,
		label: "source",
		task: "Read baseline.txt.",
		cwd: dir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "completed",
		paneId: null,
		runtime: "herdr",
		...overrides,
	};
}

test("a Claude contract without a snapshot holds the same bytes as before", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-facts-contract-"));
	try {
		const file = writeClaudeContract(dir);
		assert.equal(readFileSync(file, "utf8"), REPORTING_CONTRACT);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude contract with a snapshot holds the snapshot of the facts", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-facts-contract-"));
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(factsSnapshotFile(dir), SNAPSHOT_TEXT, "utf8");
		const file = writeClaudeContract(dir);
		const text = readFileSync(file, "utf8");
		assert.match(text, /The build fails on Windows\./, "the contract holds no snapshot");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an OMP resume keeps the snapshot of its source run", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const source = sourceJob(dir, "wz-source-omp");
		writeFileSync(factsSnapshotFile(source.sessionDir), SNAPSHOT_TEXT, "utf8");
		createGroup(rt.openDb(), "grp-wz-source-omp", source.sessionDir, Date.now());

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-omp" });

		assert.equal(resumed.status, "running", resumed.error ?? "the resume failed");
		const prompt = readFileSync(join(source.sessionDir, ".wezterm-worker-prompt.md"), "utf8");
		assert.match(prompt, /The build fails on Windows\./, "the prompt of the resume holds no snapshot");
		assert.ok(existsSync(factsSnapshotFile(source.sessionDir)), "the resume lost the snapshot");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude resume keeps the snapshot of its source run", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const source = sourceJob(dir, "wz-source-claude", {
			backend: "claude",
			nativeSessionId: "sess-1",
		});
		writeFileSync(factsSnapshotFile(source.sessionDir), SNAPSHOT_TEXT, "utf8");
		createGroup(rt.openDb(), "grp-wz-source-claude", source.sessionDir, Date.now());

		const resumed = await resumeClaudeWorker(rt, {
			jobId: "wz-resume-claude",
			source,
			sessionId: "",
		});

		assert.equal(resumed.status, "running", resumed.error ?? "the resume failed");
		const contract = readFileSync(join(source.sessionDir, ".claude-contract.md"), "utf8");
		assert.match(contract, /The build fails on Windows\./, "the contract of the resume holds no snapshot");
		assert.ok(existsSync(factsSnapshotFile(source.sessionDir)), "the resume lost the snapshot");
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

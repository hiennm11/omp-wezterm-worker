/**
 * The helpers of the tests of the runner of the worker eval.
 *
 * The file holds the fake host and the values that a test run needs. The
 * fake host answers the three worker tools and nothing else, so a test
 * runs the runner without a pane.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDataset } from "../tooling/eval/dataset.ts";
import type { RunEnvironment, RunnerHost, RunPaths } from "../tooling/eval/runner.ts";
import type { DatasetTask, PlanCell, PlanFile } from "../tooling/eval/types.ts";
import type { ToolResult } from "./harness.ts";

/** The root of the repository. */
export const ROOT = join(import.meta.dirname, "..");

/** The dataset of the pilot. */
export const DATASET_DIR = join(ROOT, "tooling/eval/datasets");

/** The directories that the tests create. */
const TEMP_DIRS: string[] = [];

/** A temporary directory that the test removes. */
export function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-runner-test-"));
	TEMP_DIRS.push(dir);
	return dir;
}

/** Remove every directory that the tests created. */
export function removeTempDirs(): void {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

/** The bugfix task of the pilot. */
export function bugfixTask(): DatasetTask {
	const loaded = loadDataset(DATASET_DIR);
	assert.ok(loaded.ok, "the dataset of the pilot must load");
	const task = loaded.dataset.tasks.find((entry) => entry.taskId === "bugfix-001");
	assert.ok(task !== undefined, "the dataset must hold the task bugfix-001");
	return task;
}

/** The environment of a test run. */
export function environment(): RunEnvironment {
	return {
		datasetVersion: "2026-11-11.1",
		packageVersion: "0.1.0",
		commit: "abc1234",
		dirty: false,
		environment: { node: "22.20.0" },
	};
}

/** The directories of a test run. */
export function paths(runDir: string): RunPaths {
	return {
		runDir,
		experimentsDir: join(runDir, "experiments"),
		fixturesDir: join(runDir, "fixtures"),
		stateDir: join(runDir, "state"),
	};
}

/** The usage report that a status row holds. */
export function usageReport(cost: number | null) {
	return {
		state: cost === null ? "unknown" : "measured",
		totals: null,
		cost,
		note: cost === null ? "the transcript holds no usage data" : null,
	};
}

/** A fake host that answers the three worker tools. */
export class FakeHost implements RunnerHost {
	/** The names of the tools that the runner called. */
	calls: string[] = [];
	/** The arguments of the spawn call. */
	spawnArgs: Record<string, unknown> | null = null;
	/** The row that the status tool answers. */
	statusRow: Record<string, unknown> = {
		workerId: "wz-test-1",
		status: "completed",
		error: null,
		stop: null,
		turns: 3,
		elapsedMs: 1200,
		transcript: "<state>/sessions/wz-test-1/session.jsonl",
		usage: usageReport(0.25),
	};
	/** The result that the result tool answers. */
	resultText = "the worker fixed the module";
	/** The spawn refuses the worker when this flag is true. */
	refuse = false;
	/** The work of the worker. It runs when the spawn starts a worker. */
	work: ((fixtureDir: string) => void) | null = null;

	async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		this.calls.push(name);
		if (name === "wezterm_spawn_worker") {
			this.spawnArgs = args;
			if (this.refuse) {
				return {
					content: [{ type: "text", text: "the extension refused the launch" }],
					isError: true,
				};
			}
			const fixtureDir = String(args.cwd ?? "");
			if (this.work !== null) this.work(fixtureDir);
			return {
				content: [{ type: "text", text: "Worker wz-test-1 started in pane 1." }],
				details: { workerId: "wz-test-1", paneId: "1" },
			};
		}
		if (name === "wezterm_worker_status") {
			return {
				content: [{ type: "text", text: "status" }],
				details: { workers: [this.statusRow], hidden: 0 },
			};
		}
		if (name === "wezterm_worker_result") {
			return {
				content: [{ type: "text", text: this.resultText }],
				details: { workerId: "wz-test-1", result: this.resultText },
			};
		}
		throw new Error(`the fake host does not answer ${name}`);
	}

	async fire(event: string, _ctx: unknown): Promise<void> {
		this.calls.push(`event:${event}`);
	}

	text(result: ToolResult): string {
		return result.content.map((entry) => entry.text).join("\n");
	}
}

/** A cell of the plan. */
export function cell(fields: Record<string, unknown> = {}): PlanCell {
	return {
		experimentId: "exp-0001",
		taskId: "bugfix-001",
		taskType: "bugfix",
		model: "omniroute/minimax/MiniMax-M3.1-Flash",
		effort: "low",
		fixtureChecksum: "sha256:aaa",
		promptHash: "sha256:bbb",
		...fields,
	} as PlanCell;
}

/** The content of a correct module. */
export const GOOD_MODULE =
	"export function add(a, b) {\n\treturn a + b;\n}\n\nexport function subtract(a, b) {\n\treturn a - b;\n}\n";

/** The plan of a test run. */
export function plan(cells: PlanCell[]): PlanFile {
	return {
		schemaVersion: 1,
		datasetVersion: "2026-11-11.1",
		pilot: true,
		models: ["omniroute/minimax/MiniMax-M3.1-Flash"],
		efforts: ["low"],
		runs: cells.length,
		experiments: cells.length,
		cells,
	};
}

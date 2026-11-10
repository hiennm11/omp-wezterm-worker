/**
 * A new OMP process adopts the worker of a closed session.
 *
 * The test starts two real OMP processes. The first process owns a running
 * worker. The first process closes its session with the command `/restart`,
 * and the process stays alive as the parent of the second process. The second
 * process resumes the same session, so it holds the same session id.
 *
 * The closing session must release the ownership row of the running worker.
 * The second process must then take the task over and deliver the result.
 * On master the closing session releases no row, so the second process reads
 * the worker and never delivers the result.
 *
 * The test needs `omp` and `wezterm`. On a machine without them the test
 * reports that it cannot run, instead of reporting a pass.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDatabase } from "../extensions/lib/db.ts";

/** The programs the test needs. */
function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN = hasProgram("omp") && hasProgram("herdr") && process.env.HERDR_ENV === "1";

/** The root of the repository that holds the extension under test. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The task of the worker. The worker runs long enough to survive the close. */
const WORKER_TASK =
	"Count from 1 to 60 slowly. Write one number per line into a file named count.txt " +
	"in the current working directory, using the write tool, one number at a time. " +
	"Then reply with the word DONE.";

/**
 * The helper extension of the two OMP processes.
 *
 * The helper loads the extension of this repository and starts one worker.
 * The marker file stops the second process from starting a second worker.
 */
function helperSource(stateDir: string): string {
	return `import worker from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "extensions", "wezterm-worker.ts")).href)};
import { existsSync, writeFileSync } from "node:fs";

const STATE_DIR = ${JSON.stringify(stateDir)};
const MARKER = STATE_DIR + "/worker-started.txt";

export default function helper(pi: any) {
	process.env.OMP_WORKER_STATE_DIR = STATE_DIR;
	process.env.OMP_WORKER_CONFIG_FILE = STATE_DIR + "/wezterm-worker.json";
	const tools = new Map<string, any>();
	const register = pi.registerTool.bind(pi);
	pi.registerTool = (definition: any) => {
		tools.set(definition.name, definition);
		register(definition);
	};
	worker(pi);
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		if (existsSync(MARKER)) return;
		const spawn = tools.get("wezterm_spawn_worker");
		if (!spawn) return;
		await spawn.execute(
			"helper",
			{ task: ${JSON.stringify(WORKER_TASK)}, cwd: ctx.cwd, label: "adopt" },
			undefined,
			undefined,
			{ cwd: ctx.cwd, sessionManager: ctx.sessionManager },
		);
		/* A session with no assistant message stays in memory, and the
		   restart gives it a new id. The call puts the session on the disk,
		   so the restart resumes the same id. */
		await ctx.sessionManager.ensureOnDisk();
		writeFileSync(MARKER, "1", "utf8");
	});
}
`;
}

/** The state of the worker in the state directory. */
function workerState(stateDir: string): {
	status: string | null;
	ownerPid: number | null;
	phase: string | null;
	delivered: number;
} {
	const file = join(stateDir, "lifecycle.db");
	if (!existsSync(file)) return { status: null, ownerPid: null, phase: null, delivered: 0 };
	const db = openDatabase(file);
	const run = db.handle.prepare("SELECT status FROM runs LIMIT 1").get() as { status: string } | undefined;
	const owner = db.handle.prepare("SELECT process_id, phase FROM ownership LIMIT 1").get() as
		| { process_id: number | null; phase: string }
		| undefined;
	const sent = db.handle.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'sent'").get() as {
		n: number;
	};
	db.close();
	return {
		status: run?.status ?? null,
		ownerPid: owner?.process_id ?? null,
		phase: owner?.phase ?? null,
		delivered: sent.n,
	};
}

/**
 * Start the first OMP process in a new tab.
 *
 * The tab gives the process a pane of its own. The command clears the
 * variables that name a worker session, because the pane inherits the
 * environment of the Herdr server.
 */
function startFirstProcess(repo: string, helper: string): string {
	const out = execFileSync("herdr", ["tab", "create", "--cwd", repo, "--no-focus"], { encoding: "utf8" });
	const reply = JSON.parse(out) as { result?: { root_pane?: { pane_id?: string } } };
	const paneId = reply.result?.root_pane?.pane_id ?? "";
	const command = `set OMP_WORKER_SESSION_DIR=&& set PI_SESSION_FILE=&& omp --no-title --no-extensions --cwd ${repo} -e ${helper}`;
	execFileSync("herdr", ["pane", "run", paneId, command], { stdio: "ignore" });
	return paneId;
}

/** The pane ids whose directory names the marker. */
function paneIdsOf(marker: string): string[] {
	const out = execFileSync("herdr", ["pane", "list"], { encoding: "utf8" });
	const reply = JSON.parse(out) as { result?: { panes?: Array<{ pane_id: string; cwd?: string }> } };
	return (reply.result?.panes ?? [])
		.filter((pane) => (pane.cwd ?? "").includes(marker))
		.map((pane) => pane.pane_id);
}

test("a new OMP process adopts the worker of a closed session", {
	skip: !CAN_RUN ? "omp or herdr is not available, or this is not a Herdr session" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-adopt-repo-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-adopt-state-"));
	const helper = join(repo, "helper.ts");
	writeFileSync(helper, helperSource(stateDir), "utf8");

	try {
		const paneId = startFirstProcess(repo, helper);
		assert.match(paneId, /^w\d+:p[0-9A-Za-z]+$/, "The first process got no pane");

		// The first process starts the worker and owns the task.
		const running = await waitFor(
			() => {
				const state = workerState(stateDir);
				return state.ownerPid !== null && state.status === "running";
			},
			180_000,
			1000,
		);
		assert.ok(running, "The first process started no worker");
		const firstPid = workerState(stateDir).ownerPid;

		// The first process closes its session. The process stays alive as
		// the parent of the second process.
		execFileSync("herdr", ["pane", "send-text", paneId, "/restart"], { stdio: "ignore" });
		execFileSync("herdr", ["pane", "send-keys", paneId, "enter"], { stdio: "ignore" });

		// The closing session releases the row of the task.
		const released = await waitFor(() => workerState(stateDir).phase === "released", 120_000, 500);
		assert.ok(released, "The closing session released no task");

		// The second process takes the task over.
		const adopted = await waitFor(
			() => {
				const owner = workerState(stateDir).ownerPid;
				return owner !== null && owner !== firstPid;
			},
			240_000,
			1000,
		);
		assert.ok(adopted, "The second process took no task over");

		// The second process delivers the result of the worker.
		const delivered = await waitFor(() => workerState(stateDir).delivered > 0, 300_000, 2000);
		assert.ok(delivered, "The second process delivered no result");
	} finally {
		for (const pane of paneIdsOf("wt-adopt-repo-")) {
			try {
				execFileSync("herdr", ["pane", "close", pane], { stdio: "ignore" });
			} catch {
				/* the pane may already be gone */
			}
		}
	}
});

/**
 * Wait for a condition.
 *
 * The test drives real programs, so it must wait for the real state of the
 * machine. A fixed delay would hide the race that the test checks.
 */
async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
	stepMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return await condition();
}

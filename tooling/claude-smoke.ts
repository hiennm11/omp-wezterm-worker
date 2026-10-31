/**
 * The smoke test of the production Claude Code backend.
 *
 * The script spawns a real Claude Code worker through the spawn tool, waits
 * for its completion report, and checks that the result reaches the main
 * session. It never touches the checkout of the user.
 *
 * Run it with:
 *
 *   node tooling/claude-smoke.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHost, removeDir, sessionContext, waitFor } from "../tests/harness.ts";

/**
 * The model of the smoke test.
 *
 * The smoke test proves the contract, not the quality of an answer. The
 * alias of the smallest model answers fastest and costs the least, and it
 * survives a release that renames the model.
 */
const SMOKE_MODEL = "haiku";

/** Build a small git repository for the worker to work in. */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "claude-smoke-"));
	writeFileSync(join(dir, "baseline.txt"), "BASELINE\n", "utf8");
	spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

/**
 * Answer the startup prompts of the session, the way the user does.
 *
 * The function waits for a prompt to appear. A prompt that never appears is
 * not a failure, because a session that was trusted before asks nothing.
 */
async function answerStartupPrompts(paneId: number): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const text = await paneText(paneId);
		if (text.includes("Yes, I trust this folder")) {
			await selectRow(paneId, text, "Yes, I trust this folder");
			await delay(3000);
			continue;
		}
		if (text.includes("new MCP servers found")) {
			await selectRow(paneId, text, "Enable selected");
			await delay(3000);
			continue;
		}
		await delay(1000);
		/* The composer is ready when the session shows its prompt. The
		   session needs no answer after that. */
		if (text.includes("bypass permissions on") || text.includes("Try ")) return;
	}
}

/**
 * Move the cursor of a prompt to the row that carries the text, and confirm.
 *
 * The cursor wraps around in a short list, so the function reads the pane
 * after every move.
 */
async function selectRow(paneId: number, text: string, target: string): Promise<void> {
	for (let step = 0; step < 12; step += 1) {
		const marked = text.split("\n").find((row) => row.includes("❯"));
		if (marked?.includes(target)) {
			await sendKey(paneId, "\u000d");
			return;
		}
		await sendKey(paneId, "\u001b[B");
		await delay(300);
		const next = await paneText(paneId);
		const nextMarked = next.split("\n").find((row) => row.includes("❯"));
		if (nextMarked?.includes(target)) {
			await sendKey(paneId, "\u000d");
			return;
		}
	}
	await sendKey(paneId, "\u000d");
}

/** Read the visible text of a pane. */
async function paneText(paneId: number): Promise<string> {
	const result = spawnSync("wezterm", ["cli", "get-text", "--pane-id", String(paneId)], {
		encoding: "utf8",
	});
	return result.stdout ?? "";
}

/** Send one key to a pane. */
async function sendKey(paneId: number, key: string): Promise<void> {
	spawnSync("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), key], {
		encoding: "utf8",
	});
	await delay(250);
}

/** Wait for a number of milliseconds. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Close the panes and the processes of an earlier run.
 *
 * A Claude process that still runs holds its session id, and the CLI refuses
 * a resume of that session. The smoke test needs a clean machine.
 */
function cleanUp(): void {
	spawnSync("powershell", [
		"-NoProfile",
		"-Command",
		"Get-Process claude -ErrorAction SilentlyContinue | Stop-Process -Force",
	]);
	const listing = spawnSync("wezterm", ["cli", "list", "--format", "json"], { encoding: "utf8" });
	try {
		const panes = JSON.parse(listing.stdout) as Array<{ pane_id: number }>;
		for (const pane of panes) {
			if (pane.pane_id > 0) spawnSync("wezterm", ["cli", "kill-pane", "--pane-id", String(pane.pane_id)]);
		}
	} catch {
		/* no pane list means nothing to close */
	}
}

/** Run the smoke test. */
async function main(): Promise<number> {
	cleanUp();
	await delay(2000);
	/* A mod that the installed CLI refuses never loads. The smoke test
	   checks it first, so a broken mod fails fast. */
	const validation = spawnSync(
		"claude",
		["plugin", "validate", join(import.meta.dirname, "..", "extensions", "claude-mod")],
		{
			encoding: "utf8",
		},
	);
	if (validation.status !== 0) {
		console.log("FAIL: the installed Claude Code refused the mod");
		console.log(validation.stdout, validation.stderr);
		return 1;
	}
	const repo = makeRepo();
	const stateDir = mkdtempSync(join(tmpdir(), "claude-smoke-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: "Read baseline.txt. Then report the task as completed with the result SMOKE-OK, using wezterm_worker_report.",
			cwd: repo,
			label: "claude-smoke",
			backend: "claude",
			model: SMOKE_MODEL,
			placement: "tab",
		});
		console.log("spawn:", host.text(spawned));
		const workerId = (spawned.details as { workerId?: string })?.workerId;
		const paneId = (spawned.details as { paneId?: number })?.paneId;
		if (!workerId || !paneId) {
			console.log("FAIL: the spawn returned no worker id or pane id");
			return 1;
		}

		/* The user answers the trust prompts in the pane. The smoke test
		   does the same, so the session reaches its composer. */
		await answerStartupPrompts(paneId);

		const completed = await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", {});
				const text = host.text(status);
				return text.includes("COMPLETED") && text.includes("SMOKE-OK");
			},
			240_000,
			2000,
		);
		const status = await host.call("wezterm_worker_status", {});
		console.log("status:", host.text(status));
		if (!completed) {
			console.log("FAIL: the worker did not complete with SMOKE-OK");
			return 1;
		}
		const dir = join(stateDir, "sessions", workerId);
		const name = readdirSync(dir).find((entry) => entry.startsWith(".wezterm-worker-reports"));
		if (!name) {
			console.log("FAIL: the run saved no report file");
			return 1;
		}
		console.log("report file:", readFileSync(join(dir, name), "utf8").trim());

		/* A finished native run keeps its measured usage. The status of a
		   finished worker must show the counts that the native CLI
		   reported, not an unknown usage. */
		const usageText = host.text(await host.call("wezterm_worker_status", { workerId }));
		console.log("usage:", usageText);
		if (!/tokens, measured \(/.test(usageText)) {
			console.log("FAIL: the finished native worker lost its measured usage");
			return 1;
		}
		console.log("PASS: the finished native worker keeps its measured usage");

		/* A native worker refuses an explicit tool list. The refusal
		   happens before the launch. */
		const refused = await host.call("wezterm_spawn_worker", {
			task: "Read baseline.txt.",
			cwd: repo,
			backend: "claude",
			tools: ["read", "grep"],
		});
		const refusedText = host.text(refused);
		console.log("tools refusal:", refusedText);
		if (!refusedText.includes("OMP worker only")) {
			console.log("FAIL: the spawn accepted a tool list for a Claude worker");
			return 1;
		}

		/* An unknown backend is refused. The extension never falls back to
		   OMP. */
		const unknown = await host.call("wezterm_spawn_worker", {
			task: "Read baseline.txt.",
			cwd: repo,
			backend: "not-a-backend",
		});
		const unknownText = host.text(unknown);
		console.log("unknown backend refusal:", unknownText);
		if (!unknownText.includes("Unknown backend")) {
			console.log("FAIL: the spawn accepted a backend that the extension does not know");
			return 1;
		}

		/* A resume reuses the native session of the source run. The CLI
		   refuses a resume while the old process still runs, so the smoke
		   test waits for the process to end. */
		await waitFor(
			() => {
				const count = spawnSync(
					"powershell",
					["-NoProfile", "-Command", "@(Get-Process claude -ErrorAction SilentlyContinue).Count"],
					{ encoding: "utf8" },
				);
				return Number.parseInt(count.stdout.trim(), 10) === 0;
			},
			30_000,
			500,
		);
		const resumed = await host.call("wezterm_worker_resume", {
			workerId,
			message:
				"Read baseline.txt again. Then report the task as completed with the result RESUME-OK, using wezterm_worker_report.",
		});
		console.log("resume:", host.text(resumed));
		const resumedId = (resumed.details as { workerId?: string })?.workerId;
		if (!resumedId) {
			console.log("FAIL: the resume returned no worker id");
			return 1;
		}
		const resumedDone = await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", {});
				return host.text(status).includes("RESUME-OK");
			},
			240_000,
			2000,
		);
		if (!resumedDone) {
			console.log("FAIL: the resumed worker produced no report");
			return 1;
		}
		console.log("PASS: the resumed Claude worker reported RESUME-OK");

		/* A steering instruction goes through the native bridge. The
		   worker queues it, and it never interrupts a running tool. The
		   worker must still run, so the smoke test sends the instruction
		   while the worker waits for it. */
		const live = await host.call("wezterm_spawn_worker", {
			task: "Wait for a follow-up instruction. Do not report anything yet.",
			cwd: repo,
			label: "claude-steer",
			backend: "claude",
			model: SMOKE_MODEL,
			placement: "tab",
		});
		const liveId = (live.details as { workerId?: string })?.workerId;
		const livePane = (live.details as { paneId?: number })?.paneId;
		if (!liveId || !livePane) {
			console.log("FAIL: the second spawn returned no worker id");
			return 1;
		}
		await answerStartupPrompts(livePane);
		/* The native submit waits until the session is free. The smoke test
		   waits for the first turn to end, so the queued instruction starts
		   its own turn. */
		await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", {});
				return host.text(status).includes("1 report(s)") || host.text(status).includes("turns     : 1");
			},
			120_000,
			2000,
		);
		await delay(5000);
		const steered = await host.call("wezterm_worker_steer", {
			workerId: liveId,
			message:
				"Read baseline.txt. Then report the task as completed with the result STEER-OK, using wezterm_worker_report.",
		});
		console.log("steer:", host.text(steered));
		console.log("steer details:", JSON.stringify(steered.details));
		const steeredDone = await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", {});
				return host.text(status).includes("STEER-OK");
			},
			240_000,
			2000,
		);
		if (!steeredDone) {
			console.log("FAIL: the steered worker produced no report");
			return 1;
		}
		console.log("PASS: the steered Claude worker reported STEER-OK");
		return 0;
	} finally {
		await host.cleanup();
		/* The Claude process holds the fixture for a moment. A failure to
		   remove it must not hide the result of the smoke test. */
		try {
			removeDir(repo);
		} catch {
			console.log("note: the fixture directory is still held by the CLI");
		}
	}
}

process.exit(await main());

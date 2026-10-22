/**
 * The Claude proof driver.
 *
 * The driver prepares the session-scoped mod, launches a real interactive
 * Claude session in a proof-owned pane, and reads the observations that the
 * mod sent to the proof listener.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvidenceStore } from "./evidence.ts";
import type { ProofListener } from "./listener.ts";
import { runProgram } from "./shared.ts";

/** The model that the proof uses for a Claude session. */
export const PROOF_CLAUDE_MODEL = "haiku";

/**
 * Write the session-scoped settings of a proof session.
 *
 * The settings ask before a shell command runs. The proof never changes the
 * global settings of the user. The file lives in the evidence directory, and
 * the session reads it for its own run only.
 */
export function writeAskSettings(evidenceDir: string): string {
	const path = join(evidenceDir, "claude-ask-settings.json");
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				permissions: {
					defaultMode: "default",
					ask: ["Bash(PowerShell:*)"],
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return path;
}

/** The directory that holds the mod template of the proof. */
export function modTemplateDir(): string {
	return join(import.meta.dirname, "claude-mod");
}

/** One Claude session under proof. */
export interface ClaudeSession {
	/** The native session id of the session. */
	sessionId: string;
	/** The pane that holds the session. */
	paneId: number;
	/** The directory of the plugin copy that the session loads. */
	pluginDir: string;
	/** The directory that holds the session transcript. */
	transcriptDir: string;
	/** The fixture that the session works in. */
	fixture: string;
}

/**
 * Copy the mod template into the evidence directory.
 *
 * The copy is the plugin that the session loads. The template in the
 * repository never changes during a proof run.
 */
export function prepareMod(evidenceDir: string): string {
	const target = join(evidenceDir, "claude-mod");
	mkdirSync(target, { recursive: true });
	cpSync(modTemplateDir(), target, { recursive: true });
	return target;
}

/**
 * Validate the mod copy with the installed Claude Code.
 *
 * The installed build decides whether the mod loads. The proof records the
 * result of the validator.
 */
export async function validateMod(pluginDir: string): Promise<{ ok: boolean; output: string }> {
	const result = await runProgram("claude", ["plugin", "validate", pluginDir]);
	return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
}

/**
 * Launch a real interactive Claude session in a proof-owned pane.
 *
 * The session runs without a print flag, without a bare flag, and without a
 * permission bypass flag. The working directory is the fixture.
 */
export async function launchSession(options: {
	sessionId: string;
	fixture: string;
	pluginDir: string;
	env: Record<string, string>;
	settings?: string;
}): Promise<{ paneId: number | null; error: string | null }> {
	const args = [
		"cli",
		"spawn",
		"--cwd",
		options.fixture,
		"--",
		"claude",
		"--session-id",
		options.sessionId,
		"--plugin-dir",
		options.pluginDir,
		"--model",
		PROOF_CLAUDE_MODEL,
	];
	if (options.settings) args.push("--settings", options.settings);
	const result = await runProgram("wezterm", args, undefined, options.env);
	if (result.code !== 0) {
		return { paneId: null, error: (result.stderr || result.stdout).trim() };
	}
	const paneId = Number.parseInt(result.stdout.trim(), 10);
	if (!Number.isFinite(paneId)) {
		return { paneId: null, error: `wezterm did not return a pane id: ${result.stdout}` };
	}
	return { paneId, error: null };
}

/** The text of a pane. */
export async function paneText(paneId: number, lines = 40): Promise<string> {
	const result = await runProgram("wezterm", ["cli", "get-text", "--pane-id", String(paneId)]);
	if (result.code !== 0) return "";
	return result.stdout
		.split("\n")
		.filter((row) => row.trim())
		.slice(-lines)
		.join("\n");
}

/**
 * Wait until the session of a pane is ready for input.
 *
 * The function returns true when the composer of the session holds no text
 * and the session does not work.
 */
export async function waitForReady(paneId: number, deadlineMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const shown = await paneText(paneId, 30);
		if (shown.trim() === "") continue;
		const busy = shown.includes("esc to interrupt") || shown.includes("Catapulting");
		const rows = shown.split("\n").filter((row) => row.trim().startsWith("❯"));
		const composer = rows.length > 0 ? rows[rows.length - 1].trim() : "";
		if (!busy && composer === "❯") return true;
	}
	return false;
}

/**
 * Type a text into a pane and submit it.
 *
 * The composer must hold no text before the type starts, and the session
 * must be idle. A session that is still starting swallows the carriage
 * return, and the text waits for another key.
 *
 * The text and the carriage return arrive as one call of key events. A
 * separate call for the carriage return leaves the composer in its edit
 * mode, and the text then waits for another key.
 *
 * A session that is working keeps the text in its composer, and a second
 * carriage return sends it.
 */
export async function typeIntoPane(paneId: number, text: string): Promise<void> {
	await waitForReady(paneId);
	await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), text]);
	await new Promise((resolve) => setTimeout(resolve, 800));
	await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), "\r"]);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const after = await paneText(paneId, 40);
	if (after.includes(text.slice(-20).trim())) {
		await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), "\r"]);
	}
}

/**
 * Answer the startup prompts of a native session.
 *
 * A fresh session asks for the trust of its workspace and for the MCP
 * servers of the project. The proof answers both: it trusts its own
 * fixture, and it enables the servers that the user configured, because the
 * feature contract requires that a worker keeps the integrations of the
 * user.
 */
export async function answerStartupPrompts(paneId: number): Promise<{ trusted: boolean; mcp: boolean }> {
	let trusted = false;
	let mcp = false;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const text = await paneText(paneId, 60);
		if (text.includes("new MCP servers found") && !mcp) {
			mcp = await answerMcpPrompt(paneId, text);
			continue;
		}
		if (text.includes("Yes, I trust this folder") && !trusted) {
			trusted = await answerTrustPrompt(paneId, text);
			continue;
		}
		const ready = text.includes("bypass permissions on") || text.includes("Try ");
		if (ready) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return { trusted, mcp };
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return { trusted, mcp };
}

/**
 * Answer the MCP trust prompt of a native session.
 *
 * The prompt asks which MCP servers may run. The proof enables them, because
 * the feature contract requires that a worker keeps the integrations of the
 * user. The proof never removes one.
 */
async function answerMcpPrompt(paneId: number, text: string): Promise<boolean> {
	const rows = text.split("\n");
	const marked = rows.findIndex((row) => row.includes("❯"));
	const enableRow = rows.findIndex((row) => row.includes("Enable selected"));
	for (let step = 0; step < Math.max(0, enableRow - marked); step += 1) {
		await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), "\u001b[B"]);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	await new Promise((resolve) => setTimeout(resolve, 400));
	await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), "\u000d"]);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	return true;
}

/**
 * Answer the workspace trust prompt of a native session.
 *
 * The proof creates its own fixture, so the prompt concerns a directory that
 * the proof owns. The proof answers it and records that it did so.
 */
async function answerTrustPrompt(paneId: number, text: string): Promise<boolean> {
	/* The proof confirms the row that names the trust, so it reads the text
	   of the marked row and moves to the row that names the trust. */
	const rows = text.split("\n");
	const marked = rows.findIndex((row) => row.includes("❯"));
	const trustRow = rows.findIndex((row) => row.includes("Yes, I trust this folder"));
	const steps = trustRow - marked;
	for (let step = 0; step < steps; step += 1) {
		await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), "\u001b[B"]);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	await runProgram("wezterm", ["cli", "send-text", "--no-paste", "--pane-id", String(paneId), "\u000d"]);
	await new Promise((resolve) => setTimeout(resolve, 2500));
	return true;
}

/**
 * Send one command to the mod through the proof listener.
 *
 * The command carries the text of the instruction. The mod takes it from the
 * listener, so the runner never types into the pane for a queued instruction.
 */
export async function sendCommand(listener: ProofListener, runId: string, text: string): Promise<string> {
	const id = `cmd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
	const response = await fetch(`${listener.baseUrl}/commands?runId=${encodeURIComponent(runId)}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${listener.token}`,
		},
		body: JSON.stringify({ id, runId, text }),
	});
	if (!response.ok) throw new Error(`The listener refused the command: ${response.status}`);
	return id;
}

/**
 * Wait until the reducer sees a completion report for the run.
 *
 * The function returns the result of the report, or null when the deadline
 * passes without one.
 */
export async function waitForCompletion(
	listener: ProofListener,
	evidence: EvidenceStore,
	predicate: (results: Array<{ id: string; phase: string }>) => boolean,
	deadlineMs: number,
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		if (predicate(listener.results())) return true;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	evidence.observe("wait", "timeout", { waitedMs: Date.now() - started });
	return false;
}

/** The directory that holds the transcript of a Claude session. */
export function transcriptDirFor(fixture: string): string {
	const home = process.env.USERPROFILE ?? "";
	const encoded = fixture.replace(/[:\\]/g, "-");
	return join(home, ".claude", "projects", encoded);
}

/** The files that hold the transcript of a session. */
export function transcriptFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return [];
}

/** Read a file when it exists. */
export function readFileOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

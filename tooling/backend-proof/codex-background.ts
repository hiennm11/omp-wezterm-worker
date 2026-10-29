/**
 * The background scenario of the Codex proof.
 *
 * The scenario proves that the return of the foreground tool and the later
 * settlement of a background task stay apart. The model starts a detached
 * process, calls the report tool, and ends its turn. The proof waits for the
 * file of the process. The file appears after the report only when the task
 * really ran in the background.
 *
 * The verdict is a pure function of the facts of the scenario. A test can
 * check it without a pane.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CodexProofOptions } from "./codex-handle.ts";
import { wait } from "./codex-server.ts";
import type { Verdict } from "./evidence.ts";

/** The content that the background file must hold. */
const EXPECTED_CONTENT = "BG-DONE";

/** The milliseconds that the proof waits between two reads of the file. */
const POLL_INTERVAL_MILLISECONDS = 1000;

/**
 * The milliseconds that the proof waits for the content of an empty file.
 *
 * The command truncates the file before it writes the content. The poll
 * gives that write this grace.
 */
const CONTENT_GRACE_MILLISECONDS = 5000;

/** The milliseconds that the proof waits for the background file. */
const BACKGROUND_WAIT_MILLISECONDS = 40000;

/**
 * Build the text of the task of the background scenario.
 *
 * The text names the absolute path of the file. A relative path lets the
 * process write the file in a directory that nobody watches.
 */
export function backgroundTaskText(fixture: string): string {
	const file = join(fixture, "bg.txt").replace(/\\/g, "/");
	return (
		"Start a detached background process that waits 15 seconds and then writes " +
		`BG-DONE to ${file}. ` +
		"Then call the wezterm_worker_report tool with state completed and result PROOF-BACKGROUND."
	);
}

/** The state of the background file after the wait. */
export interface BackgroundFile {
	/** The path of the file. */
	path: string;
	/** Whether the file appeared during the wait. */
	appeared: boolean;
	/** The time of the first appearance, in epoch milliseconds. */
	at: number | null;
	/** The content of the file. */
	content: string | null;
	/** The time that the proof waited, in milliseconds. */
	waitedMs: number;
}

/** The facts that the verdict of the background scenario reads. */
export interface BackgroundFacts {
	/** Whether a command of the turn completed. */
	commandCompleted: boolean;
	/** Whether a report of the turn arrived. */
	reportArrived: boolean;
	/** The time of the first report, in epoch milliseconds. */
	reportAt: number | null;
	/** Whether the background file appeared. */
	fileAppeared: boolean;
	/** The time of the first appearance of the file, in epoch milliseconds. */
	fileAt: number | null;
	/** The content of the background file. */
	fileContent: string | null;
	/** The time that the proof waited for the file, in milliseconds. */
	waitedMs: number;
}

/**
 * Wait for the background file of the scenario.
 *
 * The function reads the file once per second. It stops when the file
 * holds its content or after 40 seconds. It returns the time of the first
 * existence of the file and the content of the file.
 */
export async function waitForBackgroundFile(path: string): Promise<BackgroundFile> {
	const started = Date.now();
	let existedAt: number | null = null;
	while (Date.now() - started < BACKGROUND_WAIT_MILLISECONDS) {
		await wait(POLL_INTERVAL_MILLISECONDS);
		const content = readBackgroundContent(path);
		if (content === null) continue;
		if (existedAt === null) existedAt = Date.now();
		if (content !== "") {
			return { path, appeared: true, at: existedAt, content, waitedMs: Date.now() - started };
		}
		/* The command truncates the file before it writes the content. The
		   poll gives that write a grace of five seconds. A file that holds
		   nothing after that is the file that the model wrote. */
		if (Date.now() - existedAt >= CONTENT_GRACE_MILLISECONDS) {
			return { path, appeared: true, at: existedAt, content, waitedMs: Date.now() - started };
		}
	}
	return { path, appeared: false, at: null, content: null, waitedMs: Date.now() - started };
}

/**
 * Read the content of the background file.
 *
 * The function returns null when the file does not exist or when a read
 * fails. A file that a write holds at that moment is not a settled file yet.
 */
function readBackgroundContent(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

/** The item of a Codex protocol message. */
interface CodexItem {
	/** The type of the item. */
	type: string;
	/** The command of a command execution. */
	command: string;
}

/**
 * Read the item of a Codex protocol message.
 *
 * The function narrows the payload with a type guard. It returns an empty
 * item when the payload holds none.
 */
function codexItem(payload: unknown): CodexItem {
	if (!payload || typeof payload !== "object" || !("item" in payload)) {
		return { type: "", command: "" };
	}
	const item = payload.item;
	if (!item || typeof item !== "object") return { type: "", command: "" };
	const type = "type" in item && typeof item.type === "string" ? item.type : "";
	const command = "command" in item && typeof item.command === "string" ? item.command : "";
	return { type, command };
}

/**
 * Read the facts of the background scenario and record them as evidence.
 *
 * The function reads the observations of the scenario. It records the time
 * of the first command that completed, the time of the first report, and
 * the state of the background file. The observations carry the time of the
 * event, and they are written in the order of their times.
 */
export function backgroundFacts(
	options: CodexProofOptions,
	scenario: string,
	file: BackgroundFile,
): BackgroundFacts {
	const command = options.observations.find(
		(o) => o.source === "codex.item/completed" && codexItem(o.payload).type === "commandExecution",
	);
	const report = options.observations.find((o) => o.source === "report");
	const facts: BackgroundFacts = {
		commandCompleted: command !== undefined,
		reportArrived: report !== undefined,
		reportAt: report?.at ?? null,
		fileAppeared: file.appeared,
		fileAt: file.at,
		fileContent: file.content,
		waitedMs: file.waitedMs,
	};

	const events: Array<{ source: string; payload: unknown; at: number }> = [];
	if (command) {
		events.push({
			source: "background.command-completed",
			payload: { at: command.at, command: codexItem(command.payload).command },
			at: command.at,
		});
	}
	if (report) {
		events.push({ source: "background.report", payload: { at: report.at }, at: report.at });
	}
	if (file.appeared) {
		events.push({
			source: "background.file-seen",
			payload: { at: file.at, path: file.path, content: file.content },
			at: file.at ?? Date.now(),
		});
	} else {
		events.push({
			source: "background.file-missing",
			payload: { path: file.path, waitedMs: file.waitedMs },
			at: Date.now(),
		});
	}
	for (const event of events.sort((left, right) => left.at - right.at)) {
		options.evidence.observe(scenario, event.source, event.payload);
	}
	return facts;
}

/**
 * The verdict of the background scenario.
 *
 * The function is pure. It reads the facts of the scenario and returns the
 * verdict with its reason. It passes only when a command completed, a report
 * arrived, and the background file appeared with the expected content after
 * the report.
 */
export function backgroundVerdict(facts: BackgroundFacts): { verdict: Verdict; detail: string } {
	if (!facts.reportArrived) {
		return {
			verdict: "fail",
			detail: "no report arrived; the turn did not report the result of the task",
		};
	}
	if (!facts.fileAppeared) {
		return {
			verdict: "fail",
			detail: `the background task did not settle in the wait of ${Math.round(facts.waitedMs / 1000)} seconds`,
		};
	}
	if (facts.fileAt === null || facts.reportAt === null || facts.fileAt <= facts.reportAt) {
		return {
			verdict: "fail",
			detail:
				"the background file appeared before the report; the task did not run in the background, " +
				"because the turn waited for it",
		};
	}
	if (!facts.commandCompleted) {
		return {
			verdict: "fail",
			detail: "no command of the turn completed; the scenario started no background process",
		};
	}
	if (facts.fileContent !== EXPECTED_CONTENT) {
		return {
			verdict: "fail",
			detail: `the background file holds ${JSON.stringify(facts.fileContent)} instead of ${EXPECTED_CONTENT}`,
		};
	}
	const gap = Math.round((facts.fileAt - facts.reportAt) / 1000);
	return {
		verdict: "pass",
		detail:
			`the report arrived at ${facts.reportAt}; the background file appeared at ${facts.fileAt}; ` +
			`the gap is ${gap} seconds`,
	};
}

/**
 * The helpers of the tests of the delivery proof.
 *
 * A launch proves that the worker took its task. The proof reads the
 * session directory of the worker. A fake of a pane runtime must therefore
 * write a transcript into that directory, so the proof finds the evidence.
 *
 * The session directory is named in the argv of the OMP program. The helper
 * reads it from there, so a fake needs no extra configuration.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkerRuntime } from "../extensions/lib/runtime.ts";

/** The name of the transcript that the helpers write. */
const TRANSCRIPT = "session.jsonl";

/**
 * The session directory of a worker, or null when the argv names none.
 *
 * The OMP program receives the session directory with the flag
 * `--session-dir`.
 */
export function sessionDirOfArgv(argv: readonly string[]): string | null {
	const at = argv.indexOf("--session-dir");
	if (at === -1) return null;
	return argv[at + 1] ?? null;
}

/**
 * Write the transcript of a worker into its session directory.
 *
 * The transcript is the evidence that the worker took its task. A session
 * directory without a transcript holds no evidence.
 */
export function writeSessionTranscript(sessionDir: string): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, TRANSCRIPT), "{}\n", "utf8");
}

/**
 * Append one entry to the transcript of a worker.
 *
 * A resume shares the transcript of its source run. A fake must therefore
 * append to that transcript, instead of writing a new file.
 */
export function appendSessionEntry(sessionDir: string, entry: unknown): void {
	mkdirSync(sessionDir, { recursive: true });
	appendFileSync(join(sessionDir, TRANSCRIPT), `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * The entry that the memory plugin writes at the start of a session.
 *
 * The entry grows the transcript, but it records no user message. It must
 * never confirm the delivery of a message.
 */
export function bootstrapEntry(): unknown {
	return { type: "custom", customType: "memory-bootstrap", content: "The memory profile of the worker." };
}

/**
 * The entry that records a user message in a transcript.
 *
 * The entry has the shape that the transcript of OMP uses.
 */
export function userMessageEntry(text: string): unknown {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

/**
 * Write a transcript that holds the earlier turns of a source run.
 *
 * A resume shares the transcript of its source run. The transcript has the
 * shape that OMP writes.
 */
export function writeSourceTranscript(sessionDir: string): void {
	const lines = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "first task" }] } },
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
		},
	];
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, TRANSCRIPT), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

/**
 * The tracker of the delivery of a worker.
 *
 * The tracker learns the session directory from the argv of the agent start.
 * It writes the transcript when the task arrives. The transcript must
 * appear after the launch reads its baseline, because a transcript of the
 * size of the baseline is no evidence.
 */
export interface DeliveryTracker {
	/** Read the session directory from the argv of the agent start. */
	onStart(args: readonly string[]): void;
	/** Write the transcript, so the launch finds the evidence. */
	onPrompt(): void;
}

/**
 * The tracker of the delivery of a worker.
 *
 * The tracker writes the transcript when the prompt arrives. The argv of
 * the agent start names the session directory of the worker.
 */
export function deliveryTracker(): DeliveryTracker {
	let sessionDir: string | null = null;
	return {
		onStart(args) {
			const dash = args.indexOf("--");
			sessionDir = sessionDirOfArgv(dash < 0 ? [] : args.slice(dash + 1));
		},
		onPrompt() {
			if (sessionDir) writeSessionTranscript(sessionDir);
		},
	};
}

/**
 * Report the submit of a prompt, as the mod of a Claude Code worker does.
 *
 * A Claude worker proves its delivery with the observation
 * `prompt.submit.ingress` on its bridge, not with a transcript in the session
 * directory. A fake of a pane runtime calls this when the agent prompt
 * arrives.
 */
export function reportPromptSubmit(rt: WorkerRuntime, text: string): void {
	for (const bridge of rt.bridges.values()) {
		bridge.observations.push({
			backend: "claude",
			runId: null,
			sessionId: null,
			source: "prompt.submit.ingress",
			payload: { text },
		});
	}
}

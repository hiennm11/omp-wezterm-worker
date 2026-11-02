/**
 * The pane helpers of the Claude smoke test.
 *
 * The helpers play the part of the person in the pane of a worker. They
 * answer the startup questions of a session of Claude Code, because a
 * session that waits at the trust dialog never starts.
 *
 * The helpers read a pane and send keys into a pane. They never close a
 * pane.
 */

import { paneText, sendKeyToPane } from "./claude-smoke-machine.ts";
import { delay } from "./claude-smoke-shared.ts";

/** How many times the helper looks for a prompt of the startup. */
const STARTUP_ATTEMPTS = 60;

/** The wait between two reads of a pane, in milliseconds. */
const PANE_POLL_MS = 1000;

/**
 * Answer the startup prompts of a session, the way the user does.
 *
 * The function waits for a prompt to appear. A prompt that never appears is
 * not a failure, because a session that was trusted before asks nothing.
 */
export async function answerStartupPrompts(paneId: number): Promise<void> {
	for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
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
		await delay(PANE_POLL_MS);
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
export async function selectRow(paneId: number, text: string, target: string): Promise<void> {
	for (let step = 0; step < 12; step += 1) {
		const marked = text.split("\n").find((row) => row.includes("❯"));
		if (marked?.includes(target)) {
			await sendKeyToPane(paneId, "\u000d");
			await delay(250);
			return;
		}
		await sendKeyToPane(paneId, "\u001b[B");
		await delay(300);
		const next = await paneText(paneId);
		const nextMarked = next.split("\n").find((row) => row.includes("❯"));
		if (nextMarked?.includes(target)) {
			await sendKeyToPane(paneId, "\u000d");
			await delay(250);
			return;
		}
	}
	await sendKeyToPane(paneId, "\u000d");
	await delay(250);
}

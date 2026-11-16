/**
 * The helper that plays the person at the trust dialog of Claude Code.
 *
 * A Claude Code session in a new folder waits at the trust dialog, and the
 * extension never answers it (ADR 0010). A test that starts a real Claude
 * worker must answer it, as the person does. The spawn call returns only
 * after Herdr saw the agent ready, so the answer must come while the spawn
 * call still runs.
 *
 * The helper reads the panes through Herdr. It moves the cursor to the row
 * "Yes, I trust this folder" and confirms it. Each step reads the pane
 * first, so a key that the dialog dropped is sent again on the next read.
 */

import { execFileSync } from "node:child_process";

import { currentPanes } from "./harness.ts";

/** The row of the dialog that accepts the folder. */
const TRUST_ROW = "Yes, I trust this folder";

/** The mark that the dialog puts before the row under the cursor. */
const CURSOR_MARK = "❯";

/** The wait between two reads of the panes. */
const POLL_MS = 500;

/** The text of a pane, or an empty text when Herdr cannot read it. */
function paneText(paneId: string): string {
	try {
		return execFileSync("herdr", ["pane", "read", paneId, "--source", "visible"], {
			encoding: "utf8",
			windowsHide: true,
		});
	} catch {
		return "";
	}
}

/** Press one key in a pane. A pane that is gone is not an error. */
function pressKey(paneId: string, key: string): void {
	try {
		execFileSync("herdr", ["pane", "send-keys", paneId, key], { stdio: "ignore", windowsHide: true });
	} catch {
		/* the pane may already be gone */
	}
}

/**
 * The next key that moves a dialog toward the accept row, or null when the
 * text shows no trust dialog.
 */
export function nextTrustKey(text: string): "down" | "enter" | null {
	if (!text.includes(TRUST_ROW)) return null;
	const marked = text.split("\n").find((row) => row.includes(CURSOR_MARK));
	return marked?.includes(TRUST_ROW) ? "enter" : "down";
}

/**
 * Answer the trust dialog of every pane that shows it, until the returned
 * function runs.
 */
export function answerTrustDialogs(): () => void {
	/* A real timer is needed here. The dialog appears when Claude Code
	   starts, and no event of the test host announces it. */
	const timer = setInterval(() => {
		for (const paneId of currentPanes()) {
			const key = nextTrustKey(paneText(paneId));
			if (key !== null) pressKey(paneId, key);
		}
	}, POLL_MS);
	return () => clearInterval(timer);
}

/**
 * The bridge of a WezTerm Claude Code worker.
 *
 * The mod gives the worker four things:
 *
 *  - a report tool. A report is the only evidence that the owner accepts.
 *  - a command poll. The owner sends a steering instruction through it.
 *  - the observation of the native events that the owner needs.
 *  - the snapshot of the run, which a new owner gets when its address changes.
 *  - a note channel. The main session and the worker exchange notes over it.
 *
 * The mod never approves a tool and never refuses a native denial. Every
 * observer passes its event on unchanged. The mod imports no Node module, so
 * it runs inside the Claude Code host.
 *
 * The mod reads the address of the owner and its token from the environment
 * of the session. The launch sets both. The mod also reads a handover file
 * on every poll, so a worker that keeps running after a release finds its
 * new owner.
 */

import {
	deliverMainNotes,
	MCP_NOTE_TO_MAIN,
	MCP_NOTES_FROM_MAIN,
	NOTE_TO_MAIN,
	NOTES_FROM_MAIN,
	readDelivered,
	readNoteLabel,
	readNotes,
	registerNoteTools,
	writeNote,
} from "./channel.js";
import { pollCommands } from "./commands.js";
import { registerEventHandlers } from "./events.js";
import { observe, state } from "./owner.js";
import { registerReportTool } from "./report.js";

/**
 * The context that the note channel needs.
 *
 * The context names the owner of the run and the state of the session. The
 * channel module reads no state of the mod, so it stays a transport.
 */
function noteContext() {
	return {
		baseUrl: state.baseUrl,
		token: state.token,
		runId: state.runId,
		sessionId: state.sessionId,
		sessionDir: state.sessionDir,
		closed: state.closed,
		blocked: state.pendingApprovals.size > 0,
	};
}

/**
 * Deliver the pending notes of the main session.
 *
 * A note of the main session reaches the worker as its next prompt. The
 * function runs after the command poll, so a steering instruction keeps its
 * place before a note.
 */
async function pollNotes($) {
	if (!state.baseUrl || !state.token) return;
	const result = await deliverMainNotes($, noteContext(), state.deliveredNotes);
	/* The bridge names the label of a note. The mod keeps the label, so it
	   holds no copy of the shape of a note. */
	if (result.label) state.noteLabel = result.label;
	if (result.count > 0) {
		await observe($, "note.delivered", { count: result.count, runId: state.runId });
	}
}

/**
 * Register the hooks of the worker.
 *
 * The module exports only register. It registers no handler on a permission
 * event that can approve a tool, so it can never approve one.
 */
export function register(on) {
	registerEventHandlers(on, {
		noteContext,
		writeNote,
		readNotes,
		noteTool: NOTE_TO_MAIN,
		mcpNoteTool: MCP_NOTE_TO_MAIN,
		notesTool: NOTES_FROM_MAIN,
		mcpNotesTool: MCP_NOTES_FROM_MAIN,
	});

	on("session.start", async ($, e, next) => {
		state.runId = (await $.env.get("WEZTERM_WORKER_RUN_ID")) ?? null;
		state.baseUrl = (await $.env.get("WEZTERM_WORKER_URL")) ?? null;
		state.token = (await $.env.get("WEZTERM_WORKER_TOKEN")) ?? null;
		state.handoverPath = (await $.env.get("WEZTERM_WORKER_HANDOVER")) ?? null;
		state.sessionId = (await $.session.id()) ?? null;
		/* The session directory holds the file of the delivered notes. The
		   launch passes it, so the mod knows where the file lives. */
		state.sessionDir = (await $.env.get("WEZTERM_WORKER_SESSION_DIR")) ?? null;
		await observe($, "session.start", {
			cwd: e.cwd,
			isInteractive: e.isInteractive,
			sessionId: state.sessionId,
			runId: state.runId,
		});
		await registerReportTool($);
		await registerNoteTools((tool) => $.tool.register(tool));
		/* The delivered notes live in a file, so a restart of the session
		   never submits a note twice. */
		state.deliveredNotes = await readDelivered($, noteContext());
		/* The bridge names the label of a note. The mod reads it now, so a
		   turn that carries a note is known before the first poll. */
		state.noteLabel = await readNoteLabel($, noteContext());
		$.clock.every(1000, async () => {
			await pollCommands($);
			await pollNotes($);
		});
		return next(e);
	});
}

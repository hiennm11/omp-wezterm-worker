/**
 * The event handlers of a Claude Code worker.
 *
 * The handlers pass every event on unchanged. They observe the events and
 * they keep the state of the run. A handler never approves a tool and never
 * refuses a native denial.
 */

import {
	readBackgroundTask,
	readRowText,
	readStoppedTaskId,
	readTag,
} from "./background.js";
import { carriesNote, readNotes, writeNote } from "./channel.js";
import { observe, state } from "./owner.js";

import {
	buildReport,
	MCP_REPORT_TOOL,
	reportProblem,
	REPORT_TOOL,
	saveReport,
} from "./report.js";

/* The host text of a notification of a background task. The tags are text
   and not a documented field, so a new build of the host can change them. */
const TASK_ID_TAG = /<task-id>([^<]*)<\/task-id>/;
const TOOL_USE_ID_TAG = /<tool-use-id>([^<]*)<\/tool-use-id>/;
const STATUS_TAG = /<status>([^<]*)<\/status>/;

/**
 * Register the handlers of the events of a session.
 *
 * The function needs the state of the run, the observer and the note
 * channel. The caller owns them, so the handlers share one state.
 */
export function registerEventHandlers(on, deps) {
	const { noteContext, writeNote, readNotes } = deps;

	on("prompt.submit", async ($, e, next) => {
		await observe($, "prompt.submit.ingress", { text: e.text, turnId: e.turnId ?? null });
		const result = await next(e);
		await observe($, "prompt.submit.accepted", { text: e.text, turnId: e.turnId ?? null });
		return result;
	});

	on("turn.start", async ($, e, next) => {
		state.turnOpen = true;
		/* A turn that carries a note is not an instruction cycle. The note
		   changes no state of the task, so the cycle of the run stays the
		   cycle that the task started. */
		if (carriesNote(e.text, state.noteLabel)) {
			await observe($, "note.turn", {
				turnId: e.turnId,
				text: e.text,
				agentId: e.agentId ?? null,
			});
			return next(e);
		}
		state.deliveredCycleId = e.turnId ?? null;
		/* The turn that starts carries the instruction that the mod
		   submitted. The owner needs that identity, because an accepted
		   instruction blocks the completion until its cycle starts. */
		await observe($, "turn.start", {
			turnId: e.turnId,
			text: e.text,
			agentId: e.agentId ?? null,
			instructionId: state.pendingInstructionId ?? null,
		});
		state.pendingInstructionId = null;
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		state.turnOpen = false;
		await observe($, "turn.complete", {
			turnId: e.turnId ?? null,
			reason: e.reason ?? null,
			isAborted: e.isAborted ?? false,
			agentId: e.agentId ?? null,
			usage: e.usage ?? null,
			durationMs: e.durationMs ?? null,
		});
		return next(e);
	});

	on("tool.call", async ($, e, next) => {
		const callId = e.tool_use_id ?? null;
		const isReport = String(e.tool ?? "").endsWith(REPORT_TOOL);
		if (callId && !isReport) state.openCalls.set(callId, e.tool);
		const opened = {
			callId,
			tool: e.tool,
			agentId: e.agentId ?? null,
			command: typeof e.command === "string" ? e.command : null,
		};
		/* The host marks a call that starts a background task. The flag tells
		   the owner that the task outlives the call. */
		if (e.run_in_background === true) opened.background = true;
		await observe($, "tool.call.opened", opened);
		try {
			const result = await next(e);
			if (callId && !isReport) state.openCalls.delete(callId);
			if (callId) state.pendingApprovals.delete(callId);
			await observe($, "tool.call.settled", {
				callId,
				tool: e.tool,
				denied: Boolean(result?.deny),
				isError: Boolean(result?.isError),
			});
			return result;
		} catch (error) {
			if (callId && !isReport) state.openCalls.delete(callId);
			await observe($, "tool.call.failed", { callId, tool: e.tool, error: String(error) });
			throw error;
		}
	});

	on("tool.check", async ($, e, next) => {
		const decided = await next(e);
		const decision = decided?.decision ?? null;
		const callId = e.tool_use_id ?? null;
		await observe($, "tool.check", {
			callId,
			tool: e.tool,
			decision,
			reason: decided?.reason ?? null,
		});
		/* The modern permission path does not raise the classic hook. A
		   decision of "ask" means that the session waits for the person, so
		   the worker holds the request open until the call settles. */
		if (callId && decision === "ask") state.pendingApprovals.set(callId, e.tool);
		return decided;
	});

	on("session.append", async ($, e, next) => {
		const role = e.message?.role ?? null;
		const isCall = role === "user" || role === "assistant";
		if (isCall) {
			await observe($, "session.append", {
				uuid: e.uuid,
				agentId: e.agentId ?? null,
				role,
				door: e.door ?? null,
				origin: e.origin ?? null,
			});
		}
		/* A background task ends in a notification row. The row names the
		   origin of the notification, so the owner can tell the return of the
		   foreground tool from the settlement of the background task. */
		const originKind = e.origin?.kind ?? null;
		if (originKind === "task-notification") {
			const notice = readRowText(e);
			await observe($, "background.settled", {
				uuid: e.uuid,
				door: e.door ?? null,
				originKind,
				agentId: e.agentId ?? null,
				callId: readTag(notice, TOOL_USE_ID_TAG),
				taskId: readTag(notice, TASK_ID_TAG),
				status: readTag(notice, STATUS_TAG),
			});
		}
		/* The result of a background call names the task that it started. The
		   owner needs the id to link the notification to its call. */
		if (e.origin?.kind === "tool" && e.origin?.tool === "Bash") {
			const task = readBackgroundTask(e);
			if (task) {
				if (task.callId) state.backgroundCalls.set(task.taskId, task.callId);
				await observe($, "background.started", { callId: task.callId, taskId: task.taskId });
			}
		}
		/* The result of a stop names the task that the stop ended. The owner
		   needs the id to settle the row of that task. */
		if (e.origin?.kind === "tool" && e.origin?.tool === "TaskStop") {
			const taskId = readStoppedTaskId(e);
			if (taskId) {
				/* The call that started the task ends with the task, so the
				   stop names that call too. */
				const callId = state.backgroundCalls.get(taskId) ?? null;
				state.backgroundCalls.delete(taskId);
				await observe($, "background.stopped", { callId, taskId });
			}
		}
		/* A prompt that the mod submitted does not raise `prompt.submit`. It
		   reaches the transcript as a user row that names the mod. */
		const text = readRowText(e);
		if (text && text.includes("plugin sent a message")) {
			/* A row that carries a note is not an instruction. The note
			   changes no state of the task, so it never clears a pending
			   instruction. */
			if (carriesNote(text, state.noteLabel)) {
				await observe($, "note.delivered", {
					uuid: e.uuid,
					text,
					runId: state.runId,
				});
			} else {
				await observe($, "instruction.delivered", {
					uuid: e.uuid,
					text,
					instructionId: state.pendingInstructionId ?? null,
				});
				state.pendingInstructionId = null;
			}
		}
		return next(e);
	});

	registerReportHandlers(on);
	registerNoteHandlers(on, deps);
}

/** Register the handlers of the report tool. */
function registerReportHandlers(on) {
	for (const name of [REPORT_TOOL, MCP_REPORT_TOOL]) {
		on("tool.call", { tool: name }, async ($, e) => {
			const report = buildReport(state, e);
			const problem = reportProblem(report);
			if (problem) {
				await observe($, "report.rejected", { reason: problem, callId: report.callId });
				return { result: problem, isError: true };
			}
			try {
				await saveReport($, state, report);
			} catch (error) {
				return { result: `the report was not saved: ${String(error?.message ?? error)}`, isError: true };
			}
			await observe($, "report", report);
			return { result: `The task state is now ${report.state}.` };
		});
	}
}

/**
 * Register the handlers of the note tools.
 *
 * The native host calls a tool through its MCP name. The handler for the
 * plain name does not match it, so each note tool needs a handler that
 * accepts the MCP name too.
 */
function registerNoteHandlers(on, deps) {
	const { noteContext } = deps;
	const noteNames = [deps.noteTool, deps.mcpNoteTool];
	const notesNames = [deps.notesTool, deps.mcpNotesTool];
	for (const name of noteNames) {
		on("tool.call", { tool: name }, async ($, e) => {
			const text = typeof e.text === "string" ? e.text : "";
			try {
				return await writeNote($, noteContext(), text);
			} catch (error) {
				return { result: `the note was not saved: ${String(error?.message ?? error)}`, isError: true };
			}
		});
	}
	for (const name of notesNames) {
		on("tool.call", { tool: name }, async ($, e) => {
			const afterSeq = Number(e.afterSeq ?? 0);
			try {
				return await readNotes($, noteContext(), afterSeq, state.deliveredNotes);
			} catch (error) {
				return { result: `the notes were not read: ${String(error?.message ?? error)}`, isError: true };
			}
		});
	}
}

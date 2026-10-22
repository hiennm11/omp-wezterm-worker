/**
 * The proof mod of the Claude backend.
 *
 * The mod observes one native session. It never approves a tool and never
 * refuses a native denial. Every observer passes its event on unchanged.
 *
 * The mod reads its listener and its token from the environment of the
 * session. The proof runner sets both when it launches the session.
 */

/** The states that the report tool accepts. */
const REPORT_STATES = ["working", "waiting", "needs_input", "completed"];

/** The name of the report tool that the mod registers. */
const REPORT_TOOL = "wezterm_worker_report";

/** The state of the proof mod. It lives in the closure of register. */
const state = {
	/** The native session id of the session. */
	runId: null,
	/** The id of the proof run. */
	proofRunId: null,
	/** The base URL of the proof listener. */
	baseUrl: null,
	/** The bearer token of the proof listener. */
	token: null,
	/** The instructions that the native program delivered last. */
	deliveredInstructionId: null,
	/** The instruction that the mod submitted and that no turn carries yet. */
	pendingInstructionId: null,
	/** The cycle that the native program delivered last. */
	deliveredCycleId: null,
	/** The calls that started and did not settle. */
	openCalls: new Map(),
	/** The permission requests that no result resolved. */
	pendingApprovals: new Map(),
	/** The commands that the listener handed out. */
	commands: new Map(),
};

/**
 * Send one observation to the proof listener.
 *
 * The mod never writes to the transcript about its own observations. A log
 * line is a transcript row, and a row raises `session.append`, which would
 * start the same loop again.
 */
async function observe($, source, payload) {
	if (!state.baseUrl || !state.token) return;
	try {
		await $.http.fetch(`${state.baseUrl}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${state.token}`,
			},
			body: JSON.stringify({
				backend: "claude",
				runId: state.runId,
				source,
				payload,
			}),
		});
	} catch {
		/* the proof records the loss; the mod must not break the session */
	}
}

/** Report the result of one command to the proof listener. */
async function reportCommand($, id, phase, nativeId, error) {
	if (!state.baseUrl || !state.token) return;
	try {
		await $.http.fetch(`${state.baseUrl}/command-results`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${state.token}`,
			},
			body: JSON.stringify({ id, phase, nativeId: nativeId ?? null, error: error ?? null }),
		});
	} catch {
		/* the proof records the loss */
	}
}

/** Take one command from the proof listener. */
async function pollCommands($, cycleId) {
	if (!state.baseUrl || !state.token) return;
	try {
		/* The listener address and the token can change when the controller
		   recovers. The mod reads them again on every poll. */
		const url = (await $.env.get("WEZTERM_PROOF_URL")) ?? state.baseUrl;
		const token = (await $.env.get("WEZTERM_PROOF_TOKEN")) ?? state.token;
		state.baseUrl = url;
		state.token = token;
		const response = await $.http.fetch(
			`${url}/commands?runId=${encodeURIComponent(state.proofRunId ?? "")}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		await observe($, "command.poll", { status: response.status, ok: response.ok });
		if (!response.ok) return;
		const body = JSON.parse(response.text);
		const command = body?.command;
		if (!command) return;
		state.commands.set(command.id, command);
		await reportCommand($, command.id, "received", null, null);
		await observe($, "command.received", { id: command.id, text: command.text });

		if (state.pendingApprovals.size > 0) {
			await reportCommand($, command.id, "refused", null, "a permission request is open");
			await observe($, "command.refused", {
				id: command.id,
				reason: "a permission request is open",
				approvals: [...state.pendingApprovals.keys()],
			});
			return;
		}

		const instructionId = `claude-instruction-${command.id}`;
		state.pendingInstructionId = instructionId;
		/* The submit call is the native acceptance. Its promise settles when
		   the turn starts, so the acceptance is recorded at the call and the
		   delivery is recorded by the row that carries the instruction. */
		await reportCommand($, command.id, "accepted", instructionId, null);
		await observe($, "command.accepted", { id: command.id, instructionId, cycleId });
		void $.prompt
			.submit({ text: command.text })
			.then(async (result) => {
				const drop = result?.drop ?? null;
				if (drop) {
					await reportCommand($, command.id, "refused", null, drop);
					await observe($, "command.refused", { id: command.id, reason: drop });
					return;
				}
				await observe($, "command.submitted", { id: command.id, instructionId });
			})
			.catch(async (error) => {
				const reason = String(error?.message ?? error);
				await reportCommand($, command.id, "refused", null, reason);
				await observe($, "command.refused", { id: command.id, reason });
			});
	} catch {
		/* the next poll tries again */
	}
}

/** Register the report tool of the proof. */
async function registerReportTool($) {
	await $.tool.register({
		name: REPORT_TOOL,
		description:
			"Report the state of your task. Use this tool once per instruction cycle. " +
			"A report is the only evidence that the owner accepts. " +
			"Report completed only when every task-owned work has finished and you observed every background result.",
		isDeferred: false,
		inputSchema: {
			type: "object",
			properties: {
				state: { type: "string", enum: REPORT_STATES },
				result: { type: "string" },
				dependency: { type: "string" },
				resumeCondition: { type: "string" },
				needs: { type: "string" },
				detail: { type: "string" },
			},
			required: ["state"],
		},
	});
}

/** The report of one call, bound to the run and to the delivered cycle. */
function buildReport(e) {
	return {
		runId: state.proofRunId,
		sessionId: state.runId,
		cycleId: state.deliveredCycleId,
		callId: e.tool_use_id ?? null,
		state: e.state,
		result: e.result ?? null,
		dependency: e.dependency ?? null,
		resumeCondition: e.resumeCondition ?? null,
		needs: e.needs ?? null,
		detail: e.detail ?? null,
	};
}

/** The reason that a report is invalid, or null when it is valid. */
function reportProblem(report) {
	if (!REPORT_STATES.includes(report.state)) return `the state must be one of ${REPORT_STATES.join(", ")}`;
	if (report.state === "completed" && !report.result) return "a completed report needs the result of the task";
	if (report.state === "waiting" && (!report.dependency || !report.resumeCondition)) {
		return "a waiting report needs the dependency and the condition that resumes the work";
	}
	if (report.state === "needs_input" && !report.needs) {
		return "a needs input report needs the decision or information that you need";
	}
	return null;
}

/** The text of a transcript row, or null when it carries none. */
function readRowText(e) {
	const content = e.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
			.join("\n");
	}
	return null;
}

/**
 * Register the proof hooks.
 *
 * The module exports only register. It registers no handler on a permission
 * event, so it can never approve a tool.
 */
export function register(on) {
	on("session.start", async ($, e, next) => {
		state.proofRunId = (await $.env.get("WEZTERM_PROOF_RUN_ID")) ?? null;
		state.baseUrl = (await $.env.get("WEZTERM_PROOF_URL")) ?? null;
		state.token = (await $.env.get("WEZTERM_PROOF_TOKEN")) ?? null;
		state.runId = (await $.session.id()) ?? null;
		await observe($, "session.start", {
			cwd: e.cwd,
			isInteractive: e.isInteractive,
			sessionId: state.runId,
			proofRunId: state.proofRunId,
		});
		await registerReportTool($);
		$.clock.every(1000, async () => {
			await pollCommands($, state.deliveredCycleId);
		});
		return next(e);
	});

	on("prompt.submit", async ($, e, next) => {
		await observe($, "prompt.submit.ingress", { text: e.text, turnId: e.turnId ?? null });
		const result = await next(e);
		await observe($, "prompt.submit.accepted", { text: e.text, turnId: e.turnId ?? null });
		return result;
	});

	on("turn.start", async ($, e, next) => {
		state.deliveredCycleId = e.turnId ?? null;
		await observe($, "turn.start", { turnId: e.turnId, text: e.text, agentId: e.agentId ?? null });
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
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
		const isReport = e.tool === "mcp__wezterm-worker-proof__wezterm_worker_report";
		if (callId && !isReport) state.openCalls.set(callId, e.tool);
		await observe($, "tool.call.opened", {
			callId,
			tool: e.tool,
			agentId: e.agentId ?? null,
			command: typeof e.command === "string" ? e.command : null,
		});
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
		   the proof holds the request open until the call settles. */
		if (callId && decision === "ask") state.pendingApprovals.set(callId, e.tool);
		return decided;
	});

	on("session.append", async ($, e, next) => {
		const role = e.message?.role ?? null;
		/* The rows of a turn are many. The proof records the rows that carry
		   the identity of a call, and counts the rest. */
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
		   origin of the notification, so the proof can tell the return of the
		   foreground tool from the settlement of the background task. */
		const originKind = e.origin?.kind ?? null;
		if (originKind === "task-notification") {
			await observe($, "background.settled", {
				uuid: e.uuid,
				door: e.door ?? null,
				originKind,
				agentId: e.agentId ?? null,
			});
		}
		/* A prompt that the mod submitted does not raise `prompt.submit`. It
		   reaches the transcript as a user row that names the mod. */
		const text = readRowText(e);
		if (text && text.includes("wezterm-worker-proof plugin sent a message")) {
			await observe($, "instruction.delivered", {
				uuid: e.uuid,
				instructionId: state.pendingInstructionId,
				text,
			});
		}
		return next(e);
	});

	on("tool.call", { tool: "mcp__wezterm-worker-proof__wezterm_worker_report" }, async ($, e) => {
		const report = buildReport(e);
		const problem = reportProblem(report);
		if (problem) {
			await observe($, "report.rejected", { reason: problem, callId: report.callId });
			return { result: problem, isError: true };
		}
		await observe($, "report", report);
		return { result: `The task state is now ${report.state}.` };
	});

	on("classic.PermissionRequest", async ($, e, next) => {
		const key = e.tool_name ?? "unknown";
		state.pendingApprovals.set(key, JSON.stringify(e.tool_input ?? null));
		await observe($, "approval.requested", {
			tool: e.tool_name ?? null,
			input: e.tool_input ?? null,
			suggestions: e.permission_suggestions ?? null,
		});
		const result = await next(e);
		await observe($, "approval.resolved", {
			tool: e.tool_name ?? null,
			decision: result?.decision ?? null,
			reason: result?.reason ?? null,
		});
		state.pendingApprovals.delete(key);
		return result;
	});
}

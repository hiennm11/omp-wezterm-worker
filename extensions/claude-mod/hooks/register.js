/**
 * The bridge of a WezTerm Claude Code worker.
 *
 * The mod gives the worker three things:
 *
 *  - a report tool. A report is the only evidence that the owner accepts.
 *  - a command poll. The owner sends a steering instruction through it.
 *  - the observation of the native events that the owner needs.
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

/** The states that the report tool accepts. */
const REPORT_STATES = ["working", "waiting", "needs_input", "completed"];

/** The name of the report tool that the mod registers. */
const REPORT_TOOL = "wezterm_worker_report";

/** The name that the native host uses for the report tool. */
const MCP_REPORT_TOOL = "mcp__wezterm-worker__wezterm_worker_report";

/** The state of the mod. It lives in the closure of register. */
const state = {
	/** The native session id of the session. */
	sessionId: null,
	/** The id of the run that the session belongs to. */
	runId: null,
	/** The base URL of the owner. */
	baseUrl: null,
	/** The bearer token of the owner. */
	token: null,
	/** The file that holds the address and the token of the current owner. */
	handoverPath: null,
	/** The cycle that the native program delivered last. */
	deliveredCycleId: null,
	/** The calls that started and did not settle. */
	openCalls: new Map(),
	/** The permission requests that no result resolved. */
	pendingApprovals: new Map(),
	/** The commands that the owner handed out. */
	commands: new Map(),
	/** The instruction that the mod submitted and that no turn carries yet. */
	pendingInstructionId: null,
	/** True when the owner closed the bridge. The mod stops then. */
	closed: false,
};

/**
 * Read the address and the token of the current owner.
 *
 * The owner writes them into a file inside the session directory. A new
 * owner writes the file again, so a worker that keeps running after a
 * release finds its new owner. A missing or malformed file gives null, and
 * the caller keeps the address that it already has.
 */
async function readHandover($) {
	const path = state.handoverPath;
	if (!path) return null;
	try {
		const text = await $.fs.read(path);
		if (typeof text !== "string" || !text) return null;
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.url !== "string" || !parsed.url) return null;
		if (typeof parsed.token !== "string" || !parsed.token) return null;
		return { url: parsed.url, token: parsed.token };
	} catch {
		return null;
	}
}

/**
 * Send one observation to the owner.
 *
 * The mod never writes to the transcript about its own observations. A log
 * line is a transcript row, and a row raises `session.append`, which would
 * start the same loop again.
 */
async function observe($, source, payload) {
	if (state.closed) return;
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
				sessionId: state.sessionId,
				source,
				payload,
			}),
		});
	} catch {
		/* the owner records the loss; the mod must not break the session */
	}
}

/** Report the result of one command to the owner. */
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
		/* the owner records the loss */
	}
}

/** Take one command from the owner. */
async function pollCommands($) {
	if (state.closed) return;
	if (!state.baseUrl || !state.token) return;
	try {
		/* The owner address and the token can change when the owner
		   recovers. The mod reads them again on every poll. The handover
		   file holds the bridge of the current owner, so a new owner is
		   found after a release. */
		const handover = await readHandover($);
		const url = handover?.url ?? (await $.env.get("WEZTERM_WORKER_URL")) ?? state.baseUrl;
		const token = handover?.token ?? (await $.env.get("WEZTERM_WORKER_TOKEN")) ?? state.token;
		state.baseUrl = url;
		state.token = token;
		const response = await $.http.fetch(
			`${url}/commands?runId=${encodeURIComponent(state.runId ?? "")}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		/* The owner closed the bridge. A released owner writes the
		   handover file again, so a new owner is found on the next poll. A
		   run that ended removes the file, so the mod stops for good. */
		if (response.status === 410) {
			const next = await readHandover($);
			if (!next) {
				state.closed = true;
				return;
			}
			state.baseUrl = next.url;
			state.token = next.token;
			return;
		}
		if (!response.ok) return;
		const body = JSON.parse(response.text);
		const command = body?.command;
		if (!command) return;
		state.commands.set(command.id, command);
		await reportCommand($, command.id, "received", null, null);
		await observe($, "command.received", { id: command.id, text: command.text });

		/* A steering instruction is refused while a permission request is
		   open. The request stays with the person in the pane. */
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
		await observe($, "command.accepted", { id: command.id, instructionId });
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

/** Register the report tool of the worker. */
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
		runId: state.runId,
		sessionId: state.sessionId,
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
 * Register the hooks of the worker.
 *
 * The module exports only register. It registers no handler on a permission
 * event that can approve a tool, so it can never approve one.
 */
export function register(on) {
	on("session.start", async ($, e, next) => {
		state.runId = (await $.env.get("WEZTERM_WORKER_RUN_ID")) ?? null;
		state.baseUrl = (await $.env.get("WEZTERM_WORKER_URL")) ?? null;
		state.token = (await $.env.get("WEZTERM_WORKER_TOKEN")) ?? null;
		state.handoverPath = (await $.env.get("WEZTERM_WORKER_HANDOVER")) ?? null;
		state.sessionId = (await $.session.id()) ?? null;
		await observe($, "session.start", {
			cwd: e.cwd,
			isInteractive: e.isInteractive,
			sessionId: state.sessionId,
			runId: state.runId,
		});
		await registerReportTool($);
		$.clock.every(1000, async () => {
			await pollCommands($);
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
		if (text && text.includes("plugin sent a message")) {
			await observe($, "instruction.delivered", {
				uuid: e.uuid,
				text,
				instructionId: state.pendingInstructionId ?? null,
			});
			state.pendingInstructionId = null;
		}
		return next(e);
	});

	on("tool.call", { tool: REPORT_TOOL }, async ($, e) => {
		const report = buildReport(e);
		const problem = reportProblem(report);
		if (problem) {
			await observe($, "report.rejected", { reason: problem, callId: report.callId });
			return { result: problem, isError: true };
		}
		await observe($, "report", report);
		return { result: `The task state is now ${report.state}.` };
	});

	/* The native host calls the tool through its MCP name. The handler for
	   the plain name does not match it, so the report needs a handler that
	   accepts the MCP name too. */
	on("tool.call", { tool: MCP_REPORT_TOOL }, async ($, e) => {
		const report = buildReport(e);
		const problem = reportProblem(report);
		if (problem) {
			await observe($, "report.rejected", { reason: problem, callId: report.callId });
			return { result: problem, isError: true };
		}
		await observe($, "report", report);
		return { result: `The task state is now ${report.state}.` };
	});
}

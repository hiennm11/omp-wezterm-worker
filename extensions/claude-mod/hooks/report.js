/**
 * The report tool of a Claude Code worker.
 *
 * A report is the only evidence that the owner accepts. The worker sends it
 * through the tool that this module registers. The mod saves the report in
 * the file of the run, so a later reader finds it in one place.
 */

/** The states that the report tool accepts. */
export const REPORT_STATES = ["working", "waiting", "needs_input", "completed"];

/** The name of the report tool that the mod registers. */
export const REPORT_TOOL = "wezterm_worker_report";

/** The name that the native host uses for the report tool. */
export const MCP_REPORT_TOOL = `mcp__wezterm-worker__${REPORT_TOOL}`;

/** The report file of the current run, beside the handover file. */
export function reportFilePath(state) {
	const path = state.handoverPath;
	if (!path || !state.runId) throw new Error("the report file path is unavailable");
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const directory = separator < 0 ? "." : path.slice(0, separator);
	return `${directory}/.wezterm-worker-reports-${state.runId}.jsonl`;
}

/** The observation file of the current run, beside the report file. */
export function observationFilePath(state) {
	return reportFilePath(state).replace(".wezterm-worker-reports-", ".wezterm-worker-observations-");
}

/** Save one report in the JSONL format that the owner reads. */
export async function saveReport($, state, report) {
	const path = reportFilePath(state);
	let previous = "";
	try {
		const text = await $.fs.read(path);
		if (typeof text === "string") previous = text;
	} catch {
		/* the first report creates the file */
	}
	await $.fs.write(path, `${previous}${JSON.stringify({ ...report, at: Date.now() })}\n`);
}

/** The report of one call, bound to the run and to the delivered cycle. */
export function buildReport(state, e) {
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
export function reportProblem(report) {
	if (!REPORT_STATES.includes(report.state)) return `the state must be one of ${REPORT_STATES.join(", ")}`;
	if (report.state === "completed" && !report.result) return "a completed report needs the result of the task";
	if (report.state === "waiting" && (!report.dependency || !report.resumeCondition)) {
		return "a waiting report needs the dependency and the condition that resumes the work";
	}
	if (report.state === "needs_input" && !report.needs) {
		return "a needs input report needs the decision or information that the worker needs";
	}
	return null;
}

/** Register the report tool of the worker. */
export async function registerReportTool($) {
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

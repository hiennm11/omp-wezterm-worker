/**
 * wezterm_worker_report
 *
 * The worker reports the state of its task through this tool. The report is
 * the only evidence that proves task state. Ordinary answer text proves
 * nothing.
 *
 * The tool is worker-only. It writes into the worker transcript, so the
 * evidence stays in one place.
 */

import { dirname } from "node:path";

import { checkComms } from "../lib/comms-check.ts";
import type { ToolCtx } from "../lib/host.ts";
import { REPORT_STATES, type ReportState, type WorkerReport } from "../lib/report-model.ts";
import { appendReport } from "../lib/report-store.ts";
import { readRunContext } from "../lib/worker-context.ts";
import { commsDetails, commsNoticeLine, reply, type ToolDeps } from "./kit.ts";

/**
 * The session directory of the calling worker.
 *
 * The host sets the variable `PI_SESSION_FILE` for the session that the
 * process runs. The worker writes its transcript there.
 */
export function workerSessionDir(): string | null {
	const workerDir = process.env.OMP_WORKER_SESSION_DIR;
	if (workerDir) return workerDir;
	const file = process.env.PI_SESSION_FILE;
	if (!file) return null;
	return dirname(file);
}

export function registerReportTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_report",
		label: "Report Worker State",
		description:
			"Report the state of your task. Use this tool once per instruction cycle. " +
			"A report is the only evidence that the owner accepts. " +
			"Report completed only when every task-owned work has finished and you observed every background result.",
		parameters: z.object({
			state: z.string().describe(`The state of the task. One of: ${REPORT_STATES.join(", ")}.`),
			result: z.string().optional().describe("The result of the task. Required for a completed report."),
			dependency: z
				.string()
				.optional()
				.describe("The external dependency that you wait for. Required for a waiting report."),
			resumeCondition: z
				.string()
				.optional()
				.describe("The condition that resumes the work. Required for a waiting report."),
			needs: z
				.string()
				.optional()
				.describe("The decision or information that you need. Required for a needs input report."),
			detail: z.string().optional().describe("What you did in this cycle."),
		}),
		loadMode: "essential",
		async execute(_toolCallId: string, params: Record<string, unknown>, _ctx?: ToolCtx) {
			const sessionDir = workerSessionDir();
			if (!sessionDir) {
				return reply(
					"This process is not a worker. Only a worker reports its task state.",
					{ reported: false },
					true,
				);
			}
			const context = readRunContext(sessionDir);
			if (!context) {
				return reply(
					"The run context is missing. The worker was not launched by this extension.",
					{ reported: false },
					true,
				);
			}
			const state = String(params.state ?? "") as ReportState;
			if (!REPORT_STATES.includes(state)) {
				return reply(`The state must be one of ${REPORT_STATES.join(", ")}.`, { reported: false }, true);
			}
			const report: WorkerReport = {
				runId: context.runId,
				state,
				result: (params.result as string | undefined) ?? null,
				dependency: (params.dependency as string | undefined) ?? null,
				resumeCondition: (params.resumeCondition as string | undefined) ?? null,
				needs: (params.needs as string | undefined) ?? null,
				detail: (params.detail as string | undefined) ?? null,
			};
			if (state === "completed" && !report.result) {
				return reply("A completed report needs the result of the task.", { reported: false }, true);
			}
			if (state === "waiting" && (!report.dependency || !report.resumeCondition)) {
				return reply(
					"A waiting report needs the dependency and the condition that resumes the work.",
					{ reported: false },
					true,
				);
			}
			if (state === "needs_input" && !report.needs) {
				return reply(
					"A needs input report needs the decision or information that you need.",
					{ reported: false },
					true,
				);
			}
			try {
				appendReport(sessionDir, report);
			} catch (e) {
				return reply(
					`The report was not saved: ${e instanceof Error ? e.message : String(e)}`,
					{ reported: false },
					true,
				);
			}
			/* The communication check runs after the state check. The report
			   is always saved. A low score only adds a warning, so a result
			   is never refused because of its score. */
			const comms = await checkComms(
				rt.exec,
				rt.config.ste100Skill,
				report.result ?? "",
				"result",
				rt.config.commsStandard,
			);
			const text = `The task state is now ${state}.`;
			const notice = commsNoticeLine(comms, rt.config.commsStandard);
			if (notice) {
				return reply(`${text}\n${notice}`, {
					reported: true,
					runId: context.runId,
					state,
					...commsDetails(comms),
				});
			}
			return reply(text, {
				reported: true,
				runId: context.runId,
				state,
				...commsDetails(comms),
			});
		},
	});
}

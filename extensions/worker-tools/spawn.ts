/**
 * wezterm_spawn_worker
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
	backendLabel,
	backendRefusal,
	KNOWN_BACKENDS,
	readBackend,
	type WorkerBackend,
} from "../lib/backend.ts";
import { checkComms } from "../lib/comms-check.ts";
import type { Placement } from "../lib/config.ts";
import type { ToolCtx } from "../lib/host.ts";
import { admitLaunch } from "../lib/limits.ts";
import { monitorJob, monitorNativeJob } from "../lib/monitor.ts";
import { spawnWorker } from "../lib/spawn.ts";
import { spawnClaudeWorker } from "../lib/spawn-claude.ts";
import {
	commsDetails,
	commsRefusalLine,
	commsWarningLine,
	refusalReply,
	reply,
	type ToolDeps,
} from "./kit.ts";

/**
 * The backend that a spawn names, or null when the name is unknown.
 *
 * An omitted name means OMP.
 */
function readBackendParam(value: string | undefined): WorkerBackend | null {
	if (value === undefined) return "omp";
	if (value === "omp" || value === "claude" || value === "codex") return value;
	return null;
}

interface Params {
	task: string;
	cwd?: string;
	label?: string;
	model?: string;
	tools?: string[];
	backend?: string;
	placement?: string;
	isolated?: boolean;
	timeoutMs?: number;
	closePaneOnFinish?: boolean;
}

export function registerSpawnTool({ pi, rt, deliver }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_spawn_worker",
		label: "Spawn WezTerm Worker",
		description:
			"Spawn a background OMP worker session in its own WezTerm pane so the user can watch it live. " +
			"The worker is an independent omp process with its own model, tools and session file — it does " +
			"NOT inherit this conversation. Returns immediately with a worker id, pane id and transcript path; " +
			"the final result is delivered back into this session automatically when the worker finishes. " +
			"Use for long read-only or independent tasks. Prefer the native `task` tool when no pane is needed.",
		parameters: z.object({
			task: z.string().describe("Self-contained instructions for the worker. It sees only this text."),
			cwd: z
				.string()
				.optional()
				.describe("Absolute working directory for the worker. Defaults to the current session cwd."),
			label: z.string().optional().describe("Short human label shown in the pane title and in reports."),
			model: z
				.string()
				.optional()
				.describe(
					"Model selector for the worker, e.g. 'omniroute/minimax/MiniMax-M3.1-Flash'. Omit to use omp's default.",
				),
			tools: z
				.array(z.string())
				.optional()
				.describe(
					"Tool list for the worker, e.g. ['read','grep','glob']. Omit for the default tool set. " +
						"Only an OMP worker accepts it. A Claude Code or Codex worker refuses it.",
				),
			backend: z
				.string()
				.optional()
				.describe(
					"The CLI that runs the worker: 'omp' (default), 'claude' or 'codex'. " +
						"A Claude worker runs a real Claude Code session in its pane. " +
						"The extension never falls back to another backend.",
				),
			placement: z
				.string()
				.optional()
				.describe("'split' (default) splits the current pane; 'tab' opens a new tab in the current window."),
			isolated: z
				.boolean()
				.optional()
				.describe("Run the worker in its own git worktree so parallel workers never edit the same checkout."),
			timeoutMs: z
				.number()
				.optional()
				.describe(
					"Deadline for this worker in ms. 0 means no deadline. Defaults to the configured timeoutMs (30 min). Use a large value for a task that legitimately takes hours.",
				),
			closePaneOnFinish: z
				.boolean()
				.optional()
				.describe(
					"Close the worker pane when the worker finishes. Defaults to the config value (true). Set false to keep the pane open for inspection.",
				),
		}),
		loadMode: "essential",
		async execute(_id: string, params: Params, _signal: unknown, _onUpdate: unknown, ctx: ToolCtx) {
			const placement: Placement =
				params.placement === "tab" || params.placement === "split" ? params.placement : rt.config.placement;
			const backend = readBackendParam(params.backend);
			if (!backend) {
				return reply(
					`Unknown backend '${params.backend}'. Use one of: ${KNOWN_BACKENDS.join(", ")}.`,
					{ backend: params.backend },
					true,
				);
			}
			/* A backend that is not implemented is refused. The extension
			   never falls back to OMP, because that would run a different
			   program than the user asked for. */
			const refusal = backendRefusal(backend);
			if (refusal) return reply(refusal, { backend }, true);
			/* The tool list of an OMP worker has no meaning for a native
			   backend. The refusal happens before the launch. */
			if (backend !== "omp" && params.tools?.length) {
				return reply(
					`The tools parameter applies to an OMP worker only. A ${backendLabel(backend)} worker uses the tools of its own CLI.`,
					{ backend },
					true,
				);
			}
			/* The communication check runs before the launch. The enforce
			   mode refuses a task that scores below the minimum score. */
			const comms = checkComms(params.task, "task", rt.config.commsStandard);
			if (comms.verdict === "fail") {
				return reply(
					commsRefusalLine(comms, rt.config.commsStandard),
					{
						...commsDetails(comms),
						refused: "commsStandard",
					},
					true,
				);
			}
			const admitted = admitLaunch(rt, ctx.sessionManager?.getSessionFile?.());
			if ("refusal" in admitted) return refusalReply(admitted.refusal);
			const job =
				backend === "claude"
					? await spawnClaudeWorker(rt, {
							jobId: admitted.jobId,
							task: params.task,
							cwd: resolve(params.cwd || ctx.cwd),
							label: params.label,
							model: params.model ?? null,
							sessionId: randomUUID(),
							isolated: params.isolated,
							timeoutMs: params.timeoutMs,
							closePaneOnFinish: params.closePaneOnFinish,
						})
					: await spawnWorker(rt, {
							jobId: admitted.jobId,
							task: params.task,
							cwd: params.cwd || ctx.cwd,
							label: params.label,
							model: params.model,
							tools: params.tools,
							placement,
							isolated: params.isolated,
							timeoutMs: params.timeoutMs,
							closePaneOnFinish: params.closePaneOnFinish,
						});

			if (job.status === "failed") {
				return reply(
					`Worker failed to start: ${job.error ?? "unknown error"}`,
					{ workerId: job.id, status: job.status, error: job.error },
					true,
				);
			}

			/* A native backend reports through its own bridge. The
			   supervisor reads the native state instead of the transcript. */
			if (readBackend(job) === "omp") monitorJob(rt, job, deliver);
			else monitorNativeJob(rt, job, deliver);

			const lines = [
				`Worker ${job.id} started in pane ${job.paneId}.`,
				`backend: ${backendLabel(readBackend(job))}`,
				`cwd: ${job.cwd}`,
				job.model ? `model: ${job.model}` : null,
				job.worktreePath ? `isolated worktree: ${job.worktreePath} (branch ${job.worktreeBranch})` : null,
				`transcript: ${job.sessionDir}`,
				"",
				"The worker runs in the background. Its final result is delivered back into this session automatically.",
			].filter((line): line is string => line !== null);
			if (comms.verdict === "warn") lines.push(commsWarningLine(comms, rt.config.commsStandard));

			return reply(lines.join("\n"), {
				workerId: job.id,
				paneId: job.paneId,
				tabId: job.tabId,
				windowId: job.windowId,
				status: job.status,
				backend: readBackend(job),
				cwd: job.cwd,
				transcriptDir: job.sessionDir,
				worktreePath: job.worktreePath,
				...commsDetails(comms),
			});
		},
	});
}

/**
 * wezterm-worker — spawn an OMP worker session inside a WezTerm pane or tab and
 * let the user watch it live while the main agent keeps working.
 *
 * Verified against omp 18.12.3 on Windows native.
 *
 * Mechanism boundary (three distinct things, deliberately not conflated):
 *
 *  - native subagent : the `task` tool. In-process child session, no pane,
 *                       visible in the Agent Hub. Managed and result-delivered
 *                       by OMP core.
 *  - this worker     : a SEPARATE `omp` PROCESS running in a WezTerm pane, with
 *                       its own model, tools and session file. It does not
 *                       inherit the main conversation.
 *  - pane transcript : `wezterm cli get-text` only reads rendered screen text.
 *                       It is a read-only view, never used as a result source.
 *
 * The worker result comes from the worker's own session JSONL, which is the
 * authoritative artifact — not from scraping pane text.
 *
 * This file only wires the parts together. The behaviour lives in `lib/`
 * (the worker lifecycle) and `worker-tools/` (one module per tool).
 */

import { mkdirSync } from "node:fs";

import { loadConfig } from "./lib/config.ts";
import { createDeliver } from "./lib/deliver.ts";
import type { ExtensionAPI } from "./lib/host.ts";
import { failJob } from "./lib/job.ts";
import { monitorJob } from "./lib/monitor.ts";
import { paneExists } from "./lib/pane.ts";
import { createRuntime } from "./lib/runtime.ts";
import { registerCancelTool } from "./worker-tools/cancel.ts";
import { registerCleanupTool } from "./worker-tools/cleanup.ts";
import { registerPeekTool } from "./worker-tools/peek.ts";
import { registerResultTool } from "./worker-tools/result.ts";
import { registerResumeTool } from "./worker-tools/resume.ts";
import { registerRosterCommand } from "./worker-tools/roster.ts";
import { registerSpawnTool } from "./worker-tools/spawn.ts";
import { registerStatusTool } from "./worker-tools/status.ts";
import { registerSteerTool } from "./worker-tools/steer.ts";

/**
 * The runtime lives at module scope. Child sessions rebind the factory but
 * must observe the same job registry.
 */
const RUNTIME = createRuntime();

export default function weztermWorkerExtension(pi: ExtensionAPI) {
	const rt = RUNTIME;
	rt.config = loadConfig();
	mkdirSync(rt.config.stateDir, { recursive: true });
	pi.setLabel?.("WezTerm Workers");

	const deps = { pi, rt, deliver: createDeliver(pi) };

	// The registry is read eagerly, because the status tool must list the
	// finished workers straight away. Re-attaching the running ones waits for
	// `session_start`: the host throws `ExtensionRuntimeNotInitializedError`
	// when an action method is called during extension load (docs/adr/0005).
	const restored = rt.readRegistry();
	for (const job of restored.finished) rt.jobs.set(job.id, job);

	pi.on("session_start", async (_event, ctx) => {
		// Managed timers: a poll that throws must not tear the session down.
		rt.timers = {
			setInterval: (fn, ms) => {
				const handle = ctx.setInterval(fn, ms);
				handle.unref?.();
				return handle;
			},
		};

		for (const job of restored.alive) {
			rt.jobs.set(job.id, job);
			// A monitor only makes sense while the pane still exists. A pane
			// that was closed by the user ends the worker instead of hanging
			// forever.
			if (job.paneId === null || (await paneExists(rt, job.paneId))) {
				monitorJob(rt, job, deps.deliver);
				continue;
			}
			failJob(job, "Worker pane was closed before this session re-attached");
			rt.persist();
		}
	});

	pi.on("session_shutdown", () => {
		for (const timer of rt.monitors.values()) clearInterval(timer);
		rt.monitors.clear();
	});

	// Report a failed poll through the host logger, so a broken worker poll
	// is visible instead of silently swallowed.
	const drainErrors = () => {
		for (const message of rt.errors.splice(0)) {
			pi.logger?.error?.(`[wezterm-worker] ${message}`);
		}
	};
	pi.on("tool_result", drainErrors);
	pi.on("session_end", drainErrors);

	registerSpawnTool(deps);
	registerStatusTool(deps);
	registerSteerTool(deps);
	registerPeekTool(deps);
	registerResultTool(deps);
	registerResumeTool(deps);
	registerCancelTool(deps);
	registerCleanupTool(deps);
	registerRosterCommand(deps);
}

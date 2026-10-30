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

import { attachWorker } from "./lib/attach.ts";
import { lastGuidance, loadConfig } from "./lib/config.ts";
import { createDeliver } from "./lib/deliver.ts";
import { releaseEndedGroups } from "./lib/group-recovery.ts";
import type { ExtensionAPI } from "./lib/host.ts";
import { startRequest } from "./lib/limits.ts";
import { migrateRegistry } from "./lib/migrate.ts";
import { acquireTask, bindSession, maySupervise } from "./lib/owner.ts";
import { findLiveWorkers } from "./lib/process-table.ts";
import { recoverTask } from "./lib/recover-task.ts";
import { reconcileAttempts } from "./lib/recovery.ts";
import { detectRole, ownSessionDir } from "./lib/role.ts";
import { createRuntime } from "./lib/runtime.ts";
import { reconcileStopIntents } from "./lib/stop-reconcile.ts";
import { registerWorkerBootstrap } from "./lib/worker-bootstrap.ts";
import { registerAckTool } from "./worker-tools/ack.ts";
import { registerCancelTool } from "./worker-tools/cancel.ts";
import { registerCleanupTool } from "./worker-tools/cleanup.ts";
import { registerPeekTool } from "./worker-tools/peek.ts";
import { registerReleaseTool } from "./worker-tools/release.ts";
import { registerReportTool } from "./worker-tools/report.ts";
import { registerResolveTool } from "./worker-tools/resolve.ts";
import { registerResultTool } from "./worker-tools/result.ts";
import { registerResumeTool } from "./worker-tools/resume.ts";
import { registerRosterCommand } from "./worker-tools/roster.ts";
import { registerSpawnTool } from "./worker-tools/spawn.ts";
import { registerStatusTool } from "./worker-tools/status.ts";
import { registerSteerTool } from "./worker-tools/steer.ts";
import { registerTakeoverTool } from "./worker-tools/takeover.ts";

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
	// A setting that the new release refuses must not pass without a word.
	if (lastGuidance) pi.logger?.warn?.(`[wezterm-worker] ${lastGuidance}`);

	// The worker bootstrap decides the role of this process. A worker loads
	// the same extension, so the extension must give it only the report tool.
	// The role comes from the session directory of the process.
	const sessionDir = ownSessionDir();
	const role = detectRole(sessionDir);

	if (role.role === "worker") {
		// The worker gets the report tool and nothing else. The bootstrap
		// exposes the tools that the worker modules registered.
		registerReportTool({ pi, rt, deliver: () => {} });
		registerWorkerBootstrap(rt);
		return;
	}

	const deps = { pi, rt, deliver: createDeliver(pi, rt) };

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

		// The migration runs once. The old registry file stays on disk.
		const db = rt.openDb();
		const migration = migrateRegistry(db, rt.config.stateDir, 0);
		if (migration.failure?.kind === "malformed") {
			pi.logger?.error?.(`[wezterm-worker] The registry file was not migrated: ${migration.failure.detail}`);
		}

		// The session identity comes first. The recovery decides which
		// attempts this session may settle.
		bindSession(rt, ctx.sessionManager);

		// The recovery reconciles the attempts that a crash left open. It
		// never sends a launch command again. An attempt that found no
		// worker raises an event, so the owner finds it in the status.
		const workers = await findLiveWorkers(rt);
		reconcileAttempts(db, workers, rt.sessionId, Date.now());

		for (const job of restored.alive) {
			rt.jobs.set(job.id, job);
			// A task that another session or another live process owns stays
			// read-only here. A second supervisor would deliver every event
			// twice (docs/adr/0009).
			const acquisition = await acquireTask(rt, job.id);
			if (!maySupervise(acquisition)) {
				pi.logger?.warn?.(
					`[wezterm-worker] Worker ${job.id} stays read-only: ${acquisition.acquired ? "" : acquisition.reason}`,
				);
				continue;
			}
			// A monitor only makes sense while the pane still exists. A pane
			// that was closed by the user ends the worker instead of hanging
			// forever. An unreadable pane list keeps the monitor, which retries
			// any pending stop.
			await attachWorker(rt, job, deps.deliver);
		}

		// A crash can leave a stop intent pending. The reconciliation settles
		// the intents of the runs that this session owns, so a later action
		// does not act on a worker whose pane may already be closed.
		const intents = await reconcileStopIntents(rt, [...rt.jobs.values()], Date.now());
		if (intents.confirmed.length > 0 || intents.failed.length > 0) {
			pi.logger?.info?.(
				`[wezterm-worker] The startup recovery settled ${intents.confirmed.length} confirmed and ` +
					`${intents.failed.length} failed stop intent(s).`,
			);
		}

		// A crash can end a run without the code that frees its resource
		// group. The recovery frees the groups whose holder ended and whose
		// pane is gone. It runs after the loop above, so the live workers are
		// known.
		const freed = await releaseEndedGroups(rt, [...rt.jobs.values()], Date.now());
		if (freed.length > 0) {
			pi.logger?.info?.(`[wezterm-worker] The startup recovery freed ${freed.length} resource group(s).`);
		}

		// A restart can lose the result of a finished run. The recovery sends
		// the result of a run that this session owns and never delivered.
		recoverTask(rt, [...rt.jobs.values()], deps.deliver, Date.now());
	});

	pi.on("session_shutdown", () => {
		for (const timer of rt.monitors.values()) clearInterval(timer);
		rt.monitors.clear();
		// The database holds a file lock. The handle must close, or the state
		// directory cannot be removed while the process lives.
		rt.closeDb();
	});

	// A user prompt starts a new request. A worker result does not fire `input`.
	pi.on("input", () => startRequest(rt));

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
	registerAckTool(deps);
	registerSteerTool(deps);
	registerPeekTool(deps);
	registerResultTool(deps);
	registerResumeTool(deps);
	registerCancelTool(deps);
	registerCleanupTool(deps);
	registerResolveTool(deps);
	registerReleaseTool(deps);
	registerTakeoverTool(deps);
	registerRosterCommand(deps);
}

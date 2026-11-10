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
import { replayEvents } from "./lib/event-wake.ts";
import { releaseEndedGroups } from "./lib/group-recovery.ts";
import type { ExtensionAPI } from "./lib/host.ts";
import { startRequest } from "./lib/limits.ts";
import { migrateRegistry } from "./lib/migrate.ts";
import { acquireTask, bindSession, maySupervise } from "./lib/owner.ts";
import { findLiveWorkers } from "./lib/process-table.ts";
import { recoverTask } from "./lib/recover-task.ts";
import { reconcileAttempts } from "./lib/recovery.ts";
import { detectRole, ownSessionDir } from "./lib/role.ts";
import { bindPaneRuntime, createRuntime } from "./lib/runtime.ts";
import { createLeaseProbe } from "./lib/session-lease.ts";
import { releaseSessionTasks } from "./lib/session-release.ts";
import { switchSession } from "./lib/session-switch.ts";
import { reconcileStopIntents } from "./lib/stop-reconcile.ts";
import { isSubagent, sessionStartLine } from "./lib/subagent.ts";
import { leaseAnswerText } from "./lib/supervision.ts";
import { registerWorkerBootstrap } from "./lib/worker-bootstrap.ts";
import { registerAckTool } from "./worker-tools/ack.ts";
import { registerCancelTool } from "./worker-tools/cancel.ts";
import { registerCleanupTool } from "./worker-tools/cleanup.ts";
import { registerNoteToMainTool } from "./worker-tools/note-to-main.ts";
import { registerNoteToWorkerTool } from "./worker-tools/note-to-worker.ts";
import { registerNotesFromMainTool } from "./worker-tools/notes-from-main.ts";
import { registerNotesFromWorkerTool } from "./worker-tools/notes-from-worker.ts";
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
 *
 * The export gives a test the runtime of the loaded extension, so the test
 * can put an error in it.
 */
export const RUNTIME = createRuntime();

export default function weztermWorkerExtension(pi: ExtensionAPI) {
	const rt = RUNTIME;
	rt.config = loadConfig();
	bindPaneRuntime(rt);
	rt.sessionLeaseHeld = createLeaseProbe(pi);
	mkdirSync(rt.config.stateDir, { recursive: true });
	pi.setLabel?.("WezTerm Workers");

	// Temporary, for issue 128: names the factory run that owns a log line.
	const loadId = Math.random().toString(36).slice(2, 7);

	// A setting that the new release refuses must not pass without a word.
	if (lastGuidance) pi.logger?.warn?.(`[wezterm-worker] ${lastGuidance}`);

	// The worker bootstrap decides the role of this process. A worker loads
	// the same extension, so the extension must give it only the report tool.
	// The role comes from the session directory of the process.
	const sessionDir = ownSessionDir();
	const role = detectRole(sessionDir);

	if (role.role === "worker") {
		// The worker gets the report tool and the channel tools, and nothing
		// else. The bootstrap exposes the tools that the worker modules
		// registered.
		registerReportTool({ pi, rt, deliver: () => {} });
		registerNoteToMainTool({ pi, rt, deliver: () => {} });
		registerNotesFromMainTool({ pi, rt, deliver: () => {} });
		registerWorkerBootstrap(rt, pi);
		return;
	}

	const deps = { pi, rt, deliver: createDeliver(rt) };

	// The registry is read eagerly, because the status tool must list the
	// finished workers straight away. Re-attaching the running ones waits for
	// `session_start`: the host throws `ExtensionRuntimeNotInitializedError`
	// when an action method is called during extension load (docs/adr/0005).
	const restored = rt.readRegistry();
	for (const job of restored.finished) rt.jobs.set(job.id, job);

	pi.on("session_start", async (_event, ctx) => {
		pi.logger?.info?.(`${sessionStartLine(ctx)} load=${loadId}`);

		/* OMP loads the extension again for a subagent in the same process.
		   The runtime lives at module scope, so the second load shares it. A
		   subagent must not take the authority of the main session, so it
		   binds nothing, recovers nothing and attaches no monitor. */
		if (isSubagent(ctx)) return;
		// The main session owns the shared channel for wakes and deliveries.
		rt.sendToMainSession = (text: string) => {
			pi.logger?.info?.(`[wezterm-worker] diag128 send: load=${loadId} chars=${text.length}`);
			if (typeof pi.sendUserMessage === "function") {
				pi.sendUserMessage(text, { triggerTurn: true });
				return "sendUserMessage";
			}
			pi.sendMessage(text, { deliverAs: "steer", triggerTurn: true, attribution: "agent" });
			return "sendMessage";
		};
		pi.logger?.info?.(`[wezterm-worker] diag128 channel assigned: load=${loadId}`);

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
		reconcileAttempts(rt, workers, rt.sessionId, Date.now());

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
				/* The answer of the lease explains the refusal, so the log
				   names it. The answer is true, false or null. */
				if (!acquisition.acquired && acquisition.lease !== undefined) {
					pi.logger?.warn?.(
						`[wezterm-worker] The lease of session ${rt.sessionId ?? "unknown"} is ` +
							`${leaseAnswerText(acquisition.lease)}. Worker ${job.id} stays read-only.`,
					);
				}
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

		// A restart can lose the wake of an event. The recovery wakes the main
		// session for every event that this session owns, that nobody handled,
		// and that never reached the main session.
		const woken = replayEvents(rt, Date.now());
		if (woken.length > 0) {
			pi.logger?.info?.(
				`[wezterm-worker] The startup recovery woke the session for ${woken.length} event(s).`,
			);
		}
	});

	// Report a failed poll through the host logger, so a broken worker poll
	// is visible instead of silently swallowed.
	const drainErrors = () => {
		for (const message of rt.errors.splice(0)) {
			pi.logger?.error?.(`[wezterm-worker] ${message}`);
		}
	};
	pi.on("session_switch", async (_event, ctx) => {
		try {
			await switchSession(rt, ctx, deps.deliver, (message) => pi.logger?.info?.(message), "session_switch");
		} catch (e) {
			rt.errors.push(
				`The session switch could not restore worker supervision: ${e instanceof Error ? e.message : String(e)}`,
			);
			drainErrors();
		}
	});
	pi.on("session_branch", async (_event, ctx) => {
		try {
			await switchSession(rt, ctx, deps.deliver, (message) => pi.logger?.info?.(message), "session_branch");
		} catch (e) {
			rt.errors.push(
				`The session branch could not restore worker supervision: ${e instanceof Error ? e.message : String(e)}`,
			);
			drainErrors();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		/* The runtime is shared by every session of the process. The end of
		   a subagent must not stop the monitors of the main session and must
		   not close its database. */
		if (isSubagent(ctx)) return;

		/* A closing session gives up the tasks that it still supervises. The
		   next process of the same session adopts the running worker through
		   the existing path of a released row. The step runs before the
		   monitors clear, because the release reads the state of the runs. */
		try {
			rt.persist();
		} catch (e) {
			rt.errors.push(
				`The state of the session could not be saved: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		try {
			const released = await releaseSessionTasks(rt);
			if (released.length > 0) {
				pi.logger?.info?.(
					`[wezterm-worker] The closing session released ${released.length} running task(s): ${released.join(", ")}.`,
				);
			}
		} catch (e) {
			rt.errors.push(
				`The release of the running tasks failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		// The last errors of the session must reach the logger before the
		// database closes. OMP emits no other event for the end of a session.
		try {
			drainErrors();
		} catch (e) {
			rt.errors.push(
				`The errors of the session could not be reported: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		try {
			for (const timer of rt.monitors.values()) clearInterval(timer);
			rt.monitors.clear();
		} catch (e) {
			rt.errors.push(
				`The monitors of the session could not be stopped: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		// The database holds a file lock. The handle must close, or the state
		// directory cannot be removed while the process lives.
		try {
			rt.closeDb();
		} catch (e) {
			rt.errors.push(
				`The database of the session could not close: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	});

	// A user prompt starts a new request. A worker result does not fire `input`.
	pi.on("input", () => startRequest(rt));

	pi.on("tool_result", drainErrors);

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
	registerNoteToWorkerTool(deps);
	registerNotesFromWorkerTool(deps);
	registerRosterCommand(deps);
}

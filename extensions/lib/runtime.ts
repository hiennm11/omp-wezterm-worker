/**
 * The worker runtime: the state and the services every module shares.
 *
 * One runtime lives at module scope in the extension entry. Child sessions
 * rebind the extension factory but must observe the same job registry, so the
 * state cannot live inside the factory.
 *
 * Modules receive the runtime as an argument. A test builds a runtime with a
 * fake `exec` and needs no real process.
 */

import { DEFAULT_CONFIG, type WorkerConfig } from "./config.ts";
import type { Job } from "./job.ts";
import { type RunFn, type RunResult, run } from "./process.ts";
import { loadRegistry, persistRegistry } from "./registry.ts";

/**
 * Managed timers.
 *
 * OMP runs extensions in-process with no isolation: a raw `setInterval`
 * callback that throws becomes a process-level `uncaughtException` and tears
 * the whole session down. Every background poll therefore goes through the
 * host's `ctx.setInterval`, which contains the failure, and every callback
 * carries its own try/catch as a second line of defence.
 */
export interface TimerHost {
	setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export interface WorkerRuntime {
	/** Replaced on every factory bind so a session picks up the current file and env values. */
	config: WorkerConfig;
	readonly jobs: Map<string, Job>;
	readonly monitors: Map<string, NodeJS.Timeout>;
	/** Errors raised inside a background poll, waiting to be reported through the host logger. */
	readonly errors: string[];
	timers: TimerHost;
	nextJobId: () => string;
	/** Write the registry of this session to disk. */
	persist: () => void;
	/** Read the registry of this session from disk. */
	readRegistry: () => { finished: Job[]; alive: Job[] };
	exec: RunFn;
	wezterm: (args: string[]) => Promise<RunResult>;
	git: (cwd: string, args: string[]) => Promise<RunResult>;
	/** Start a poll. A throw inside the callback is recorded and the poll keeps running. */
	startInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
	stopMonitor: (jobId: string) => void;
	/** How long a stop waits for the pane list to show the pane gone. */
	stopConfirm: { attempts: number; intervalMs: number };
	/** Ids of the workers with a stop in flight. */
	readonly stopping: Set<string>;
	/** Ids of the workers launched since the last user prompt. */
	requestLaunches: string[];
}

export function createRuntime(exec: RunFn = run): WorkerRuntime {
	let sequence = 0;
	const rt: WorkerRuntime = {
		config: { ...DEFAULT_CONFIG },
		jobs: new Map(),
		monitors: new Map(),
		errors: [],
		stopConfirm: { attempts: 20, intervalMs: 250 },
		stopping: new Set(),
		requestLaunches: [],
		timers: {
			setInterval: (fn, ms) => {
				const timer = setInterval(fn, ms);
				timer.unref?.();
				return timer;
			},
		},
		nextJobId() {
			sequence += 1;
			return `wz-${Date.now().toString(36)}-${sequence.toString(36)}`;
		},
		persist() {
			persistRegistry(rt.config.stateDir, rt.jobs.values());
		},
		readRegistry() {
			return loadRegistry(rt.config.stateDir);
		},
		exec,
		wezterm: (args) => exec(rt.config.weztermBin, ["cli", ...args]),
		git: (cwd, args) => exec("git", args, cwd),
		startInterval(fn, ms) {
			return rt.timers.setInterval(() => {
				try {
					fn();
				} catch (e) {
					// A failed poll must never end the session.
					rt.errors.push(e instanceof Error ? e.message : String(e));
				}
			}, ms);
		},
		stopMonitor(jobId) {
			const timer = rt.monitors.get(jobId);
			if (timer) {
				clearInterval(timer);
				rt.monitors.delete(jobId);
			}
		},
	};
	return rt;
}

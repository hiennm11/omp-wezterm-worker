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

import type { BridgeState } from "./claude-bridge.ts";
import type { ClaudeRunState } from "./claude-run-state.ts";
import { DEFAULT_CONFIG, type WorkerConfig } from "./config.ts";
import { databaseFile, type LifecycleDb, openDatabase } from "./db.ts";
import type { Job } from "./job.ts";
import { type RunFn, type RunResult, run } from "./process.ts";
import { loadRuns, persistRuns } from "./runs.ts";

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

/**
 * A tool that only a worker process may call.
 *
 * The worker bootstrap registers these tools. A main session does not get
 * them, so a main session cannot report a task state that it does not own.
 */
export interface WorkerToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
}

/**
 * A tool that only the owner of a task may call.
 *
 * The owner tool checks the authority of the task before it acts.
 */
export interface OwnerToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
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
	/** Open the lifecycle database of this state directory, once. */
	openDb: () => LifecycleDb;
	/**
	 * Close the lifecycle database.
	 *
	 * The database holds a file lock. A test that removes the state
	 * directory must close the handle first.
	 */
	closeDb: () => void;
	exec: RunFn;
	wezterm: (args: string[], env?: NodeJS.ProcessEnv) => Promise<RunResult>;
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
	/** The lifecycle database of this state directory. */
	db: LifecycleDb | null;
	/** The file of the open database handle. */
	dbFile: string | null;
	/** The session file of the calling session, when the host gives one. */
	sessionFile: string | null;
	/** The stable identity of the calling session, when the host gives one. */
	sessionId: string | null;
	/**
	 * The tools that a worker process may call.
	 *
	 * A worker is a separate OMP process. It must not supervise other
	 * workers. It may only report the state of its own task.
	 */
	readonly workerTools: Map<string, WorkerToolDefinition>;
	/** Register a tool that only a worker process may call. */
	registerWorkerTool: (definition: WorkerToolDefinition) => void;
	/**
	 * The tools that only the owner of a task may call.
	 *
	 * The owner is the main session that holds the authority of a task.
	 * Every owner tool checks that authority before it acts.
	 */
	readonly ownerTools: Map<string, OwnerToolDefinition>;
	/** Register a tool that only the owner of a task may call. */
	registerOwnerTool: (definition: OwnerToolDefinition) => void;
	/** The identity of the owner of this process. Null when it owns nothing. */
	ownerId: string | null;
	/** The generation of the ownership of this process. */
	ownerGeneration: number;
	/** The role of this process. A worker never supervises another worker. */
	role: "main" | "worker";
	/**
	 * The external actions that started and did not settle yet.
	 *
	 * The release reads this list. It waits for every action before it moves
	 * the authority to another session.
	 */
	readonly pendingActions: Set<string>;
	/**
	 * Run an external action under the operation gate.
	 *
	 * The gate serializes the start of an action and the move into the
	 * releasing phase. An action that starts after the release waits for the
	 * action that started before it.
	 */
	runAction: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
	/**
	 * The bridges of the runs that talk to a native backend.
	 *
	 * A run with a native backend owns one bridge. The bridge holds the
	 * observations of the run and the commands of the owner.
	 */
	readonly bridges: Map<string, BridgeState>;
	/**
	 * The native state of the runs that talk to Claude Code.
	 *
	 * A run with a Claude backend owns one state. The state holds the
	 * current cycle, the open calls and the open permission requests.
	 */
	readonly claudeStates: Map<string, ClaudeRunState>;
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
		db: null,
		dbFile: null,
		sessionFile: null,
		sessionId: null,
		workerTools: new Map(),
		ownerTools: new Map(),
		ownerId: null,
		ownerGeneration: 0,
		role: "main",
		pendingActions: new Set(),
		bridges: new Map(),
		claudeStates: new Map(),
		async runAction<T>(name: string, fn: () => Promise<T>): Promise<T> {
			rt.pendingActions.add(name);
			try {
				return await fn();
			} finally {
				rt.pendingActions.delete(name);
			}
		},
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
			persistRuns(rt.openDb(), rt.jobs.values());
		},
		readRegistry() {
			return loadRuns(rt.openDb());
		},
		openDb() {
			// The state directory can change when a test host replaces it. A
			// handle for another directory must not be reused.
			const file = databaseFile(rt.config.stateDir);
			if (rt.db && rt.dbFile === file) return rt.db;
			rt.db?.close();
			rt.db = openDatabase(file);
			rt.dbFile = file;
			return rt.db;
		},
		closeDb() {
			rt.db?.close();
			rt.db = null;
			rt.dbFile = null;
		},
		registerWorkerTool(definition) {
			rt.workerTools.set(definition.name, definition);
		},
		registerOwnerTool(definition) {
			rt.ownerTools.set(definition.name, definition);
		},
		exec,
		wezterm: (args, env) => exec(rt.config.weztermBin, ["cli", ...args], undefined, env),
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
			/* A worker has two polls: the transcript poll and the report
			   poll. Both must stop, or the report poll of a finished
			   worker keeps reading the reports of a run that ended. */
			for (const key of [jobId, `${jobId}:reports`]) {
				const timer = rt.monitors.get(key);
				if (!timer) continue;
				clearInterval(timer);
				rt.monitors.delete(key);
			}
		},
	};
	return rt;
}

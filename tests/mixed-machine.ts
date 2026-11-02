/**
 * The fake machine of the tests of the mixed backends.
 *
 * A mixed test holds workers of the OMP backend, of the Claude Code backend
 * and of the Codex backend in one runtime. The machine answers like a machine
 * with panes, with a process table and with an app server of Codex. The
 * programs and the panes are the only fakes. Every other part is the code of
 * the extension.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexClient } from "../extensions/lib/codex-client.ts";
import { delay } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

import { codexClient, type MachineState, powershellAnswer, weztermAnswer } from "./mixed-machine-answers.ts";

/** The polls of a runtime that a test runs by hand. */
export interface MixedTimers {
	/** Run every registered poll. */
	tick: () => void;
}

/** The options of a host of a mixed test. */
export interface HostOptions {
	/** The state directory of the host. A second host may share it. */
	stateDir?: string;
	/** The session that owns the workers. */
	sessionId?: string;
	/** The id of the process of the host. */
	processId?: number;
	/** The start time of the process of the host. */
	processStartedAt?: string;
	/** The pane list cannot be read. */
	listCode?: number;
	/** A killed pane stays in the list, so a stop is not confirmed. */
	keepPaneOnKill?: boolean;
}

/** The fake machine of a mixed test. */
export interface MixedMachine {
	/** The runtime that holds the workers of the test. */
	rt: WorkerRuntime;
	/** The state directory of the test. */
	dir: string;
	/** The panes that the machine holds now. */
	panes: Set<number>;
	/** The panes that the extension closed. */
	killedPanes: number[];
	/** The programs that the extension started, in order. */
	programs: string[];
	/** The number of pane launches. */
	launches: number;
	/** The commands of `taskkill` that the extension made. */
	taskkills: string[];
	/** The requests that the client of Codex made. */
	clientCalls: { method: string; params: Record<string, unknown> }[];
	/** The number of clients of Codex that the extension closed. */
	clientCloses: number;
	/** The transcript file of a pane of an OMP worker. */
	transcripts: Map<number, string>;
	/** The path of the Codex program of the machine. */
	codexBin: string;
	/** The turn that the thread of Codex still runs. */
	openTurn: string | null;
	/** Connect to the app server of Codex. */
	connect: (endpoint: string) => Promise<CodexClient>;
	/** Send a message of the app server to the newest client. */
	deliver: (method: string, params: Record<string, unknown>) => void;
	/** Remove the app server of Codex from the process table of the machine. */
	forgetCodexProcess: () => void;
	/** The number of commands of `taskkill` that fail before they succeed. */
	taskkillFailures: number;
	/** A killed pane stays in the list, so a stop is not confirmed. */
	keepPaneOnKill: boolean;
	/** The polls of the runtime. */
	timers: MixedTimers;
	/** Start another host on the same state directory. */
	newHost: (options: HostOptions) => MixedMachine;
	/** Close the bridges, the database and the directory of the test. */
	cleanup: () => Promise<void>;
}

/** Build the fake machine of a mixed test. */
export function mixedMachine(options: HostOptions = {}): MixedMachine {
	const dir = options.stateDir ?? mkdtempSync(join(tmpdir(), "wt-mixed-"));
	const state: MachineState = {
		panes: new Set<number>(),
		killedPanes: [],
		programs: [],
		launches: 0,
		taskkills: [],
		clientCalls: [],
		transcripts: new Map<number, string>(),
		processes: new Map(),
		clients: [],
		codexBin: join(dir, "codex.exe"),
		openTurn: null,
		nextPane: 100,
		nextPid: 4200,
		nextThread: 0,
		clientCloses: 0,
		keepPaneOnKill: options.keepPaneOnKill ?? false,
		taskkillFailures: 0,
	};
	/* The Codex program of the machine must exist, because the extension
	   checks the file before it starts it. */
	if (!options.stateDir) writeFileSync(state.codexBin, "fake codex", "utf8");
	return makeHost(state, dir, options, true);
}

/** Build one host over the shared state of a test. */
function makeHost(state: MachineState, dir: string, options: HostOptions, own: boolean): MixedMachine {
	const processId = options.processId ?? 4242;
	const processStartedAt = options.processStartedAt ?? "2026-01-01T00:00:00.000Z";
	const listCode = options.listCode ?? 0;
	const answerOptions = { processId, processStartedAt, listCode };

	const exec = async (bin: string, args: string[]) => {
		const command = args.join(" ");
		if (bin === "wezterm") return weztermAnswer(state, command, answerOptions);
		if (bin === "taskkill") {
			state.taskkills.push(command);
			if (state.taskkillFailures > 0) {
				state.taskkillFailures -= 1;
				return { code: 1, stdout: "", stderr: "the taskkill failed" };
			}
			const pid = Number.parseInt(args[args.indexOf("/PID") + 1] ?? "", 10);
			if (Number.isFinite(pid)) state.processes.delete(pid);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (bin === "powershell") return powershellAnswer(state, command, answerOptions);
		if (args[0] === "--version") {
			return {
				code: 0,
				stdout: bin === state.codexBin ? "codex-cli 0.166.0" : "1.0.0",
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const connect = async (_endpoint: string): Promise<CodexClient> => codexClient(state);

	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.codexBin = state.codexBin;
	rt.sessionId = options.sessionId ?? "session-mixed";
	rt.processId = processId;
	rt.codexConnect = connect;
	rt.stopConfirm = { attempts: 2, intervalMs: 1 };

	const fns: (() => void)[] = [];
	rt.timers = {
		setInterval: (fn) => {
			fns.push(fn);
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};

	return {
		rt,
		dir,
		panes: state.panes,
		killedPanes: state.killedPanes,
		programs: state.programs,
		get launches() {
			return state.launches;
		},
		taskkills: state.taskkills,
		clientCalls: state.clientCalls,
		get clientCloses() {
			return state.clientCloses;
		},
		transcripts: state.transcripts,
		codexBin: state.codexBin,
		get openTurn() {
			return state.openTurn;
		},
		set openTurn(value: string | null) {
			state.openTurn = value;
		},
		connect,
		deliver: (method, params) => {
			const client = state.clients[state.clients.length - 1];
			client?.deliver({ method, params });
		},
		forgetCodexProcess: () => {
			state.processes.clear();
		},
		get taskkillFailures() {
			return state.taskkillFailures;
		},
		set taskkillFailures(value: number) {
			state.taskkillFailures = value;
		},
		get keepPaneOnKill() {
			return state.keepPaneOnKill;
		},
		set keepPaneOnKill(value: boolean) {
			state.keepPaneOnKill = value;
		},
		timers: {
			tick: () => {
				for (const fn of [...fns]) fn();
			},
		},
		newHost: (hostOptions) => makeHost(state, dir, hostOptions, false),
		cleanup: async () => {
			await Promise.all([...rt.bridges.values()].map((bridge) => bridge.close()));
			rt.bridges.clear();
			rt.claudeStates.clear();
			rt.closeDb();
			if (own && !options.stateDir) {
				/* The database holds a file lock, so every host must close
				   its handle before the directory goes. A host that still
				   holds the file keeps the directory, so the removal may
				   fail without breaking the test. */
				await delay(0);
				try {
					rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				} catch {
					/* the directory stays in the temporary folder */
				}
			}
		},
	};
}

/**
 * The fakes of the tests of a Codex spawn.
 *
 * A Codex spawn starts an app server in a pane, a TUI in a second pane and a
 * turn in the thread of that server. The tests need a runtime whose program
 * table answers like the machine, and a client that records its calls.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexClient, CodexProtocolMessage } from "../extensions/lib/codex-client.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** The options of the fake runtime. */
export interface CodexFakeOptions {
	/** The version that the Codex program reports. */
	version?: string;
	/** The method of the client that answers with an error. */
	failClientMethod?: string;
	/** The number of client calls that succeed before the failure starts. */
	failAfter?: number;
	/** The number of the connection that fails. The first connection is one. */
	failClientConnect?: number;
	/** The exit code of the pane list. A code other than zero hides the list. */
	listCode?: number;
	/** The TUI pane does not start. */
	failTuiLaunch?: boolean;
	/** The number of processes that match the server of the test. */
	serverProcessCount?: number;
	/** The name of the server process of the test. */
	serverProcessName?: string;
	/** The number of the pane of the server. */
	serverPaneId?: number;
	/** The number of the pane of the TUI. */
	tuiPaneId?: number;
	/** How long the launch waits for the process of the app server. */
	serverWaitMs?: number;
	/** The number of calls of `taskkill` that fail before they succeed. */
	taskkillFailures?: number;
	/** The processes of the machine before the launch starts. */
	seedProcesses?: Array<{ pid: number; name: string; commandLine: string }>;
	/** The id of the turn that the thread of the test still runs. */
	openTurnId?: string;
}

/** The fake runtime of the tests of a Codex spawn. */
export interface CodexFake {
	/** The runtime of the test. */
	rt: WorkerRuntime;
	/** The state directory of the test. */
	dir: string;
	/** The steps of the launch in the order that the extension made them. */
	order: string[];
	/** The calls of WezTerm. */
	weztermCalls: string[][];
	/** The programs that the fake was asked to start, in order. */
	programs: string[];
	/** The panes that the fake holds. */
	panes: Set<number>;
	/** The panes that the fake closed. */
	killedPanes: number[];
	/** The commands of `taskkill` that the fake received. */
	taskkills: string[];
	/** The requests that the client made. */
	clientCalls: { method: string; params: Record<string, unknown> }[];
	/** The number of times that a client of the test was closed. */
	clientCloses: number;
	/** The clients that the test closed. */
	closedClients: number[];
	/** The fake client of the test. */
	connect: (endpoint: string) => Promise<CodexClient>;
	/** Close the bridges of the runs. A live bridge holds the event loop. */
	closeBridges: () => Promise<void>;
}

/**
 * Build the fake runtime of a test.
 *
 * The fake answers the version check, the process table and the pane list.
 * The client records the steps of the launch in the order of the test.
 */
export function codexFake(options: CodexFakeOptions = {}): CodexFake {
	const version = options.version ?? "codex-cli 0.166.0";
	const serverPaneId = options.serverPaneId ?? 11;
	const tuiPaneId = options.tuiPaneId ?? 12;
	const serverProcessCount = options.serverProcessCount ?? 1;
	const serverProcessName = options.serverProcessName ?? "codex.exe";
	let taskkillFailures = options.taskkillFailures ?? 0;

	const dir = mkdtempSync(join(tmpdir(), "wt-codex-"));
	const binary = join(dir, "codex.exe");
	writeFileSync(binary, "fake codex", "utf8");

	const order: string[] = [];
	const weztermCalls: string[][] = [];
	const programs: string[] = [];
	const panes = new Set<number>();
	const killedPanes: number[] = [];
	const taskkills: string[] = [];
	const clientCalls: { method: string; params: Record<string, unknown> }[] = [];
	let clientCloses = 0;
	/* The processes of the fake machine. A program that the taskkill ended is
	   gone, so a second read of the process table does not name it. */
	const processes = new Map<number, { name: string; commandLine: string }>();
	let nextProcessId = 4200;
	let endpoint = "";
	for (const row of options.seedProcesses ?? []) {
		processes.set(row.pid, { name: row.name, commandLine: row.commandLine });
		if (row.pid >= nextProcessId) nextProcessId = row.pid + 1;
	}

	const exec = async (
		bin: string,
		args: string[],
	): Promise<{ code: number; stdout: string; stderr: string }> => {
		const command = args.join(" ");
		if (bin === "wezterm") return weztermAnswer(command);
		if (bin === "taskkill") {
			taskkills.push(command);
			if (taskkillFailures > 0) {
				taskkillFailures -= 1;
				return { code: 1, stdout: "", stderr: "the taskkill failed" };
			}
			const pid = Number.parseInt(args[args.indexOf("/PID") + 1] ?? "", 10);
			if (Number.isFinite(pid)) processes.delete(pid);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (bin === "powershell") return powershellAnswer(command);
		if (args[0] === "--version") return { code: 0, stdout: version, stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};

	const weztermAnswer = (command: string) => {
		weztermCalls.push(command.split(" "));
		/* The program of a pane stands after the "--" of the WezTerm
		   command. The test reads it to know which CLI started. */
		const program = command.split("-- ").pop()?.split(" ")[0] ?? "";
		if (command.includes("app-server")) {
			endpoint = command.split("--listen ")[1]?.split(" ")[0] ?? endpoint;
			panes.add(serverPaneId);
			for (let index = 0; index < serverProcessCount; index += 1) {
				const pid = nextProcessId;
				nextProcessId += 1;
				processes.set(pid, {
					name: serverProcessName,
					commandLine: `"${binary}" app-server --listen ${endpoint}`,
				});
			}
			order.push("server-pane");
			programs.push(program);
			return { code: 0, stdout: String(serverPaneId), stderr: "" };
		}
		if (command.includes("--remote")) {
			if (options.failTuiLaunch) return { code: 1, stdout: "", stderr: "the TUI did not start" };
			panes.add(tuiPaneId);
			order.push("tui-pane");
			programs.push(program);
			return { code: 0, stdout: String(tuiPaneId), stderr: "" };
		}
		if (command.includes("kill-pane")) {
			const paneId = Number(command.split("--pane-id")[1]?.trim() ?? "-1");
			panes.delete(paneId);
			killedPanes.push(paneId);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command.includes("list --format json")) {
			const code = options.listCode ?? 0;
			if (code !== 0) return { code, stdout: "", stderr: "" };
			const listing = [...panes].map((pane_id) => ({ pane_id, tab_id: 1, window_id: 1 }));
			return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const powershellAnswer = (command: string) => {
		if (command.includes("Select-Object ProcessId,Name,CommandLine")) {
			const wanted = command.includes("ProcessId = ")
				? Number.parseInt(command.split("ProcessId = ")[1]?.split(" ")[0] ?? "", 10)
				: null;
			const rows = [...processes.entries()]
				.filter(([pid]) => wanted === null || pid === wanted)
				.map(([pid, row]) => ({
					ProcessId: pid,
					Name: row.name,
					CommandLine: row.commandLine,
				}));
			if (rows.length === 0) return { code: 0, stdout: "", stderr: "" };
			return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
		}
		if (command.includes("ForEach-Object")) {
			const pid = Number.parseInt(command.split("ProcessId = ")[1]?.split(" ")[0] ?? "", 10);
			const name = processes.get(pid)?.name ?? "";
			if (!name) return { code: 0, stdout: "", stderr: "" };
			return { code: 0, stdout: name, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.config.codexBin = binary;

	let connections = 0;
	const closedClients: number[] = [];
	const connect = async (target: string): Promise<CodexClient> => {
		endpoint = target;
		connections += 1;
		const number = connections;
		const fails = connections === (options.failClientConnect ?? 1);
		order.push("initialize");
		order.push("initialized");
		let calls = 0;
		return {
			request: async (method: string, params: Record<string, unknown> = {}) => {
				order.push(method);
				clientCalls.push({ method, params });
				calls += 1;
				if (fails && method === options.failClientMethod && calls > (options.failAfter ?? 0)) {
					return {
						id: 1,
						error: { code: -1, message: `the ${method} of the fake failed` },
					} satisfies CodexProtocolMessage;
				}
				if (method === "thread/start") {
					return { id: 1, result: { thread: { id: "thread-1" } } } satisfies CodexProtocolMessage;
				}
				if (method === "thread/turns/list") {
					const turnId = options.openTurnId ?? null;
					const data = turnId === null ? [] : [{ id: turnId, status: "inProgress" }];
					return { id: 1, result: { data } } satisfies CodexProtocolMessage;
				}
				return { id: 1, result: {} } satisfies CodexProtocolMessage;
			},
			notify: (method: string, params: Record<string, unknown> = {}) => {
				order.push(method);
				clientCalls.push({ method, params });
			},
			close: () => {
				clientCloses += 1;
				closedClients.push(number);
			},
			setMessageHandler: () => undefined,
		};
	};
	/* The tool of a spawn reaches the app server through the seam of the
	   runtime, so the fake client answers every connection. */
	rt.codexConnect = connect;

	return {
		rt,
		dir,
		order,
		weztermCalls,
		programs,
		panes,
		killedPanes,
		taskkills,
		clientCalls,
		get clientCloses() {
			return clientCloses;
		},
		closedClients,
		connect,
		closeBridges: async () => {
			for (const bridge of rt.bridges.values()) await bridge.close();
		},
	};
}

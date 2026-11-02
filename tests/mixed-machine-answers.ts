/**
 * The answers of the fake machine of the tests of the mixed backends.
 *
 * The answers stand for the two programs that the extension reads: the
 * WezTerm CLI and the process table of PowerShell. The panes and the
 * processes are the only fakes. Every other part is the code of the
 * extension.
 */

import { appendFileSync } from "node:fs";

import type { CodexClient, CodexProtocolMessage } from "../extensions/lib/codex-client.ts";

/** One process of the fake machine. */
export interface FakeProcess {
	pid: number;
	name: string;
	commandLine: string;
}

/** The state that the answers of the machine read. */
export interface MachineState {
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
	/** The transcript file of a pane of an OMP worker. */
	transcripts: Map<number, string>;
	/** The processes of the machine. */
	processes: Map<number, FakeProcess>;
	/** The clients of Codex that the extension opened. */
	clients: { deliver: (message: CodexProtocolMessage) => void }[];
	/** The path of the Codex program of the machine. */
	codexBin: string;
	/** The turn that the thread of Codex still runs. */
	openTurn: string | null;
	/** The id of the next pane. */
	nextPane: number;
	/** The id of the next process. */
	nextPid: number;
	/** The number of the next thread of Codex. */
	nextThread: number;
	/** The number of clients of Codex that the extension closed. */
	clientCloses: number;
	/** A killed pane stays in the list, so a stop is not confirmed. */
	keepPaneOnKill: boolean;
	/** The number of commands of `taskkill` that fail before they succeed. */
	taskkillFailures: number;
}

/** The answer of one program of the machine. */
export interface MachineAnswer {
	code: number;
	stdout: string;
	stderr: string;
}

/** The options of the answers of the machine. */
export interface AnswerOptions {
	/** The id of the process of the host. */
	processId: number;
	/** The start time of the process of the host. */
	processStartedAt: string;
	/** The exit code of the pane list. A code other than zero hides the list. */
	listCode: number;
}

/** The answer of the WezTerm CLI. */
export function weztermAnswer(state: MachineState, command: string, options: AnswerOptions): MachineAnswer {
	if (command.includes("list --format json")) {
		if (options.listCode !== 0) return { code: options.listCode, stdout: "", stderr: "" };
		const listing = [...state.panes].map((pane_id) => ({ pane_id, tab_id: 1, window_id: 1 }));
		return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
	}
	if (command.includes("kill-pane")) {
		const paneId = Number.parseInt(command.split("--pane-id")[1]?.trim() ?? "-1", 10);
		if (!state.keepPaneOnKill) state.panes.delete(paneId);
		state.killedPanes.push(paneId);
		return { code: 0, stdout: "", stderr: "" };
	}
	if (command.includes("get-text")) return { code: 0, stdout: "bypass permissions on", stderr: "" };
	if (command.includes("send-text")) return sendText(state, command);
	if (command.includes("set-tab-title")) return { code: 0, stdout: "", stderr: "" };
	/* A pane launch. The program of the pane stands after the "--". */
	const program = command.split("-- ").pop()?.split(" ")[0] ?? "";
	const paneId = state.nextPane;
	state.nextPane += 1;
	state.panes.add(paneId);
	state.programs.push(program.split(/[\\/]/).pop() ?? program);
	state.launches += 1;
	if (command.includes("app-server")) {
		const port = command.split("--listen ")[1]?.split(" ")[0] ?? "";
		const pid = state.nextPid;
		state.nextPid += 1;
		state.processes.set(pid, {
			pid,
			name: "codex.exe",
			commandLine: `"${state.codexBin}" app-server --listen ${port}`,
		});
	}
	return { code: 0, stdout: String(paneId), stderr: "" };
}

/**
 * A send into a pane of an OMP worker writes the instruction into the
 * transcript, so the delivery of the instruction can be confirmed.
 */
function sendText(state: MachineState, command: string): MachineAnswer {
	const after = command.split("--pane-id ")[1] ?? "";
	const space = after.indexOf(" ");
	const paneId = Number.parseInt(after.slice(0, space), 10);
	const text = after.slice(space + 1).replace(/\r$/, "");
	const file = state.transcripts.get(paneId);
	if (file) {
		const line = JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text }] },
		});
		appendFileSync(file, `${line}\n`, "utf8");
	}
	return { code: 0, stdout: "", stderr: "" };
}

/** The answer of the process table of PowerShell. */
export function powershellAnswer(
	state: MachineState,
	command: string,
	options: AnswerOptions,
): MachineAnswer {
	if (command.includes("Name = 'codex.exe'")) {
		const rows = [...state.processes.values()].map((row) => ({
			ProcessId: row.pid,
			Name: row.name,
			CommandLine: row.commandLine,
		}));
		return { code: 0, stdout: rows.length === 0 ? "" : JSON.stringify(rows), stderr: "" };
	}
	if (command.includes("ProcessId = ")) {
		const pid = Number.parseInt(command.split("ProcessId = ")[1]?.split(" ")[0] ?? "", 10);
		const row = state.processes.get(pid);
		if (!row) return { code: 0, stdout: "", stderr: "" };
		return {
			code: 0,
			stdout: JSON.stringify({
				ProcessId: row.pid,
				Name: row.name,
				CommandLine: row.commandLine,
			}),
			stderr: "",
		};
	}
	if (command.includes("Get-Process -Id")) {
		/* Only the process of this host exists. The start time of a process
		   that is gone is empty, so the owner of a task that ended looks
		   gone. */
		const pid = Number.parseInt(command.split("Get-Process -Id ")[1]?.split(" ")[0] ?? "", 10);
		if (pid !== options.processId) return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: options.processStartedAt, stderr: "" };
	}
	if (command.includes("Name = 'claude.exe'")) return { code: 0, stdout: "0", stderr: "" };
	return { code: 0, stdout: "[]", stderr: "" };
}

/**
 * The client of the app server of Codex.
 *
 * The client answers the calls of the protocol of the extension. The test
 * records every call, so a test can check the requests of the extension.
 */
export function codexClient(state: MachineState): Promise<CodexClient> {
	state.nextThread += 1;
	const threadId = `thread-${state.nextThread}`;
	let handler: (message: CodexProtocolMessage) => void = () => undefined;
	state.clients.push({ deliver: (message) => handler(message) });
	return Promise.resolve({
		request: async (method: string, params: Record<string, unknown> = {}) => {
			state.clientCalls.push({ method, params });
			if (method === "thread/start") return { id: 1, result: { thread: { id: threadId } } };
			if (method === "thread/turns/list") {
				const data = state.openTurn === null ? [] : [{ id: state.openTurn, status: "inProgress" }];
				return { id: 1, result: { data } };
			}
			return { id: 1, result: {} };
		},
		notify: (method: string, params: Record<string, unknown> = {}) => {
			state.clientCalls.push({ method, params });
		},
		close: () => {
			state.clientCloses += 1;
		},
		setMessageHandler: (next) => {
			handler = next;
		},
	});
}

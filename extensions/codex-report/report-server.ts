/**
 * The report server of a Codex worker.
 *
 * The server is a stdio MCP server. The app server of Codex starts it and
 * the worker calls its report tool. The server posts every report to the
 * bridge of the run, and it answers the call only after the post succeeded.
 *
 * The server reads the address and the token of the bridge from the handover
 * file of its session directory. A restart of OMP gives the run a new
 * bridge, and the new owner writes that file again. The server reads the
 * file on every post, so the worker follows the new owner. A missing file or
 * a malformed file gives the address and the token of the environment.
 *
 * The server imports only Node modules. It reads the address, the token and
 * the run id from its environment, so the token never reaches a command
 * line.
 */

import { createInterface } from "node:readline";

import { readHandover } from "../lib/bridge-handover.ts";
import type { ReportState } from "../lib/report-model.ts";
import { appendReport } from "../lib/report-store.ts";

/** The name of the MCP server and of its report tool. */
const REPORT_TOOL = "wezterm_worker_report";

/** The states that the report tool accepts. */
const REPORT_STATES = ["working", "waiting", "needs_input", "completed"];

/** The field of the metadata of a call that holds the turn metadata. */
const TURN_METADATA_FIELD = "x-codex-turn-metadata";

/** The protocol version that the server answers with. */
const PROTOCOL_VERSION = "2024-11-05";

/** The version that the server names in its answer. */
const SERVER_VERSION = "0.1.0";

/** The bridge that the report server posts to. */
export interface ReportTarget {
	/** The address of the bridge of the run. */
	url: string;
	/** The token that every request of the bridge must carry. */
	token: string;
	/** The id of the run. */
	runId: string;
	/** The session directory of the run. The report file lives there. */
	sessionDir: string | null;
}

/** One message of the JSON-RPC protocol. */
export interface ReportMessage {
	id?: unknown;
	method?: string;
	params?: Record<string, unknown>;
}

/**
 * The reason that a report is invalid, or null when it is valid.
 *
 * The rules are the rules of ADR 0010. A completed report needs the result
 * of the task, a waiting report needs the dependency and the condition that
 * resumes the work, and a needs input report needs the decision or the
 * information that the worker needs.
 */
export function reportProblem(params: Record<string, unknown>): string | null {
	const state = String(params.state ?? "");
	if (!REPORT_STATES.includes(state)) return `The state must be one of ${REPORT_STATES.join(", ")}.`;
	if (state === "completed" && !params.result) return "A completed report needs the result of the task.";
	if (state === "waiting" && (!params.dependency || !params.resumeCondition)) {
		return "A waiting report needs the dependency and the condition that resumes the work.";
	}
	if (state === "needs_input" && !params.needs) {
		return "A needs input report needs the decision or information that you need.";
	}
	return null;
}

/**
 * The target that the server posts to.
 *
 * The handover file of the session directory names the bridge of the current
 * owner. The server reads the file on every post, so a restart of OMP does
 * not lose the reports of the worker. A missing file or a malformed file
 * gives the address and the token of the environment.
 */
export function resolveTarget(env: NodeJS.ProcessEnv = process.env): ReportTarget {
	const sessionDir = env.WEZTERM_WORKER_SESSION_DIR;
	const handover = sessionDir ? readHandover(sessionDir) : null;
	return {
		url: handover?.url ?? env.WEZTERM_WORKER_URL ?? "",
		token: handover?.token ?? env.WEZTERM_WORKER_TOKEN ?? "",
		runId: env.WEZTERM_WORKER_RUN_ID ?? "",
		sessionDir: sessionDir ?? null,
	};
}

/**
 * The turn id that a call of the report tool carries.
 *
 * The app server of Codex sends the turn id in the metadata of the call. A
 * real run of codex-cli 0.166.0 put it in the field
 * `x-codex-turn-metadata` of the field `_meta`. The id of that turn is the
 * id that the event `turn/started` names, so the report binds to the cycle
 * of that turn.
 *
 * The function reads no state, so a test can call it. A call without that
 * metadata gives null, and the report then names no cycle.
 */
export function turnIdOf(params: Record<string, unknown>): string | null {
	const meta = params._meta;
	if (!meta || typeof meta !== "object") return null;
	const turnMetadata = (meta as Record<string, unknown>)[TURN_METADATA_FIELD];
	if (!turnMetadata || typeof turnMetadata !== "object") return null;
	const turnId = (turnMetadata as Record<string, unknown>).turn_id;
	return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

/**
 * Post one report to the bridge of the run.
 *
 * The function returns true when the bridge accepted the report. A bridge
 * that refuses the report or that cannot be reached gives false.
 */
export async function postReport(target: ReportTarget, payload: unknown): Promise<boolean> {
	try {
		const response = await fetch(`${target.url}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${target.token}`,
			},
			body: JSON.stringify({
				backend: "codex",
				runId: target.runId,
				source: "report",
				payload,
			}),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** The JSON-RPC response of one request. */
function jsonRpc(id: unknown, result: unknown): Record<string, unknown> {
	return { jsonrpc: "2.0", id, result };
}

/** The JSON-RPC error of one request. */
function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The description of the report tool. */
const REPORT_TOOL_DESCRIPTION =
	"Report the state of your task. Use this tool once per instruction cycle. " +
	"A report is the only evidence that the owner accepts.";

/** The input schema of the report tool. */
const REPORT_TOOL_SCHEMA = {
	type: "object",
	properties: {
		state: { type: "string", enum: REPORT_STATES },
		result: { type: "string" },
		dependency: { type: "string" },
		resumeCondition: { type: "string" },
		needs: { type: "string" },
		detail: { type: "string" },
	},
	required: ["state"],
};

/**
 * Write the report to the report file of the run.
 *
 * The bridge of the run is the live channel. It closes when the owner of the
 * run releases the task, and the next owner starts a new bridge. The report
 * file is the durable channel, so a report that arrives in that gap is not
 * lost. The next owner reads the file and finds the report.
 *
 * The function never throws. The report file is a convenience, and a file
 * that cannot be written must not stop the report.
 *
 * The file holds the turn id of the report, so a report that arrives while no
 * owner holds the task keeps the cycle that produced it.
 */
function writeReportFile(target: ReportTarget, args: unknown, cycleId: string | null): void {
	if (!target.sessionDir || !target.runId) return;
	const params = (args ?? {}) as Record<string, unknown>;
	const state = String(params.state ?? "");
	if (!REPORT_STATES.includes(state as ReportState)) return;
	try {
		appendReport(target.sessionDir, {
			runId: target.runId,
			cycleId,
			state: state as ReportState,
			result: typeof params.result === "string" ? params.result : null,
			dependency: typeof params.dependency === "string" ? params.dependency : null,
			resumeCondition: typeof params.resumeCondition === "string" ? params.resumeCondition : null,
			needs: typeof params.needs === "string" ? params.needs : null,
			detail: typeof params.detail === "string" ? params.detail : null,
		});
	} catch {
		/* the file is a convenience, never a requirement */
	}
}

/**
 * Answer one message of the JSON-RPC protocol.
 *
 * The function returns the answer of the message, or null when the message
 * needs no answer. A notification never gets an answer. The server reads
 * the handover file on every post, so the reports of the worker follow the
 * current owner.
 */
export async function handleMessage(
	message: ReportMessage,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
	const id = message.id ?? null;
	const method = message.method ?? "";

	if (method === "initialize") {
		return jsonRpc(id, {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: REPORT_TOOL, version: SERVER_VERSION },
		});
	}
	if (method === "notifications/initialized" || method === "initialized") return null;
	if (method === "ping") return jsonRpc(id, {});
	if (method === "tools/list") {
		return jsonRpc(id, {
			tools: [
				{
					name: REPORT_TOOL,
					description: REPORT_TOOL_DESCRIPTION,
					inputSchema: REPORT_TOOL_SCHEMA,
				},
			],
		});
	}
	if (method === "tools/call") {
		const params = (message.params ?? {}) as Record<string, unknown>;
		if (params.name !== REPORT_TOOL) {
			return jsonRpcError(id, -32602, `unknown tool ${String(params.name)}`);
		}
		const args = (params.arguments ?? {}) as Record<string, unknown>;
		const problem = reportProblem(args);
		if (problem) return jsonRpc(id, { content: [{ type: "text", text: problem }], isError: true });
		/* The turn id names the cycle that produced the report. A call
		   without that id names no cycle, and the supervisor then binds the
		   report to no cycle. */
		const cycleId = turnIdOf(params);
		/* The report reaches the owner before the answer does. A report that
		   the bridge refused is a failure of the channel, and the worker must
		   know it. The report file keeps the report even when the bridge of
		   the run is gone, so the next owner still reads it. */
		const target = resolveTarget(env);
		writeReportFile(target, args, cycleId);
		const recorded = await postReport(target, { ...args, cycleId });
		if (!recorded) {
			return jsonRpcError(id, -32000, "The bridge of the run did not record the report.");
		}
		return jsonRpc(id, {
			content: [{ type: "text", text: `The task state is now ${String(args.state)}.` }],
			isError: false,
		});
	}
	if (id !== null) return jsonRpcError(id, -32601, `unknown method ${method}`);
	return null;
}

/**
 * Run the report server.
 *
 * The server reads newline-delimited JSON-RPC from stdin and writes the same
 * form to stdout. Every diagnostic goes to stderr.
 */
export function runReportServer(): void {
	const lines = createInterface({ input: process.stdin });

	lines.on("line", (line) => {
		void (async () => {
			let message: ReportMessage;
			try {
				message = JSON.parse(line) as ReportMessage;
			} catch {
				process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "parse error"))}\n`);
				return;
			}
			const answer = await handleMessage(message, process.env);
			if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
		})();
	});
}

/* The server runs only when it is the program of the launch. A test imports
   the module and calls the functions of it. */
if (process.argv[1] && import.meta.filename === process.argv[1]) {
	runReportServer();
}

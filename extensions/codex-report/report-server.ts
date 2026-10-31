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

/** The name of the MCP server and of its report tool. */
const REPORT_TOOL = "wezterm_worker_report";

/** The states that the report tool accepts. */
const REPORT_STATES = ["working", "waiting", "needs_input", "completed"];

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
	};
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
 * Answer one message of the JSON-RPC protocol.
 *
 * The function returns the answer of the message, or null when the message
 * needs no answer. A notification never gets an answer. The server reads the
 * handover file on every post, so the reports of the worker follow the
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
		const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
		if (params.name !== REPORT_TOOL) {
			return jsonRpcError(id, -32602, `unknown tool ${String(params.name)}`);
		}
		const args = params.arguments ?? {};
		const problem = reportProblem(args);
		if (problem) return jsonRpc(id, { content: [{ type: "text", text: problem }], isError: true });
		/* The report reaches the owner before the answer does. A report that
		   the bridge refused is a failure of the channel, and the worker must
		   know it. */
		const recorded = await postReport(resolveTarget(env), args);
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

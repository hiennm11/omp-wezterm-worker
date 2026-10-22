/**
 * The report server of the Codex proof.
 *
 * The server is a proof-only MCP stdio server. Codex loads it through a
 * per-invocation configuration override. It implements only the methods that
 * the proof needs: initialize, tools/list and tools/call.
 *
 * The server writes its observations to the authenticated proof listener. It
 * answers a report call only after the listener recorded the report.
 */

import { createInterface } from "node:readline";

/** The report tool that the server exposes. */
const REPORT_TOOL = "wezterm_worker_report";

/** The states that the report tool accepts. */
const REPORT_STATES = ["working", "waiting", "needs_input", "completed"];

/** The reason that a report is invalid, or null when it is valid. */
function reportProblem(params: Record<string, unknown>): string | null {
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

/** Send one observation to the proof listener. */
async function observe(
	baseUrl: string,
	token: string,
	runId: string,
	source: string,
	payload: unknown,
): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ backend: "codex", runId, source, payload }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** The JSON-RPC response of one request. */
function jsonRpc(id: unknown, result: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id, result });
}

/** The JSON-RPC error of one request. */
function jsonRpcError(id: unknown, code: number, message: string): string {
	return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Run the report server.
 *
 * The server reads newline-delimited JSON-RPC from stdin and writes the same
 * form to stdout. Every diagnostic goes to stderr.
 */
export function runReportServer(): void {
	const baseUrl = process.env.WEZTERM_PROOF_URL ?? "";
	const token = process.env.WEZTERM_PROOF_TOKEN ?? "";
	const runId = process.env.WEZTERM_PROOF_RUN_ID ?? "";
	const lines = createInterface({ input: process.stdin });
	const protocolVersion = process.env.WEZTERM_PROOF_MCP_VERSION ?? "2024-11-05";

	const write = (text: string) => {
		process.stdout.write(`${text}\n`);
	};

	lines.on("line", (line) => {
		void (async () => {
			let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
			try {
				message = JSON.parse(line) as typeof message;
			} catch {
				write(jsonRpcError(null, -32700, "parse error"));
				return;
			}
			const id = message.id ?? null;
			const method = message.method ?? "";

			if (method === "initialize") {
				write(
					jsonRpc(id, {
						protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "wezterm_worker_proof", version: "0.1.0" },
					}),
				);
				return;
			}
			if (method === "notifications/initialized" || method === "initialized") return;
			if (method === "tools/list") {
				write(
					jsonRpc(id, {
						tools: [
							{
								name: REPORT_TOOL,
								description:
									"Report the state of your task. Use this tool once per instruction cycle. " +
									"A report is the only evidence that the owner accepts.",
								inputSchema: {
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
								},
							},
						],
					}),
				);
				return;
			}
			if (method === "tools/call") {
				const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
				if (params.name !== REPORT_TOOL) {
					write(jsonRpcError(id, -32602, `unknown tool ${String(params.name)}`));
					return;
				}
				const args = params.arguments ?? {};
				const problem = reportProblem(args);
				if (problem) {
					write(
						jsonRpc(id, {
							content: [{ type: "text", text: problem }],
							isError: true,
						}),
					);
					return;
				}
				const recorded = await observe(baseUrl, token, runId, "report", args);
				if (!recorded) {
					write(jsonRpcError(id, -32000, "The proof listener did not record the report."));
					return;
				}
				write(
					jsonRpc(id, {
						content: [{ type: "text", text: `The task state is now ${String(args.state)}.` }],
						isError: false,
					}),
				);
				return;
			}
			if (method === "ping") {
				write(jsonRpc(id, {}));
				return;
			}
			if (id !== null) write(jsonRpcError(id, -32601, `unknown method ${method}`));
		})();
	});
}

runReportServer();

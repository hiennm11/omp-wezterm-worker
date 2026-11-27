/**
 * The facts of a Claude Code worker.
 *
 * The worker proposes a fact. The proposal waits in the session directory of
 * the run. Only the main session promotes it.
 *
 * The mod never reads a fact file. It calls the bridge, and the bridge writes
 * the file. The mod holds no copy of the shape of a fact.
 */

/** The name of the tool that proposes a fact. */
export const PROPOSE_FACT = "wezterm_worker_propose_fact";

/** The name that the native host uses for the fact tool. */
export const MCP_PROPOSE_FACT = `mcp__wezterm-worker__${PROPOSE_FACT}`;

/**
 * The description of the tool that proposes a fact.
 *
 * The text matches the description of the tool of an OMP worker, so the main
 * session never needs to know the backend of a worker.
 */
export const PROPOSE_FACT_DESCRIPTION =
	"Propose a fact to the main session. " +
	"The fact waits in your session directory until the main session promotes it. " +
	"A proposed fact changes nothing for another worker.";

/**
 * Propose a fact of the worker.
 *
 * The bridge owns the file of the proposed facts, so the mod never writes it.
 */
export async function proposeFact($, context, key, text) {
	const body = JSON.stringify({ runId: context.runId, key, text });
	const response = await $.http.fetch(`${context.baseUrl}/facts/propose`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${context.token}`,
		},
		body,
	});
	const parsed = JSON.parse(response.text);
	if (!response.ok) {
		return { isError: true, result: String(parsed?.error ?? "the fact was not proposed") };
	}
	return { result: String(parsed?.text ?? "The fact is proposed. The main session promotes it.") };
}

/** Register the tool that proposes a fact. */
export async function registerFactTools(registerTool) {
	await registerTool({
		name: PROPOSE_FACT,
		description: PROPOSE_FACT_DESCRIPTION,
		isDeferred: false,
		inputSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "The key of the fact. A short name that is unique in the store." },
				text: { type: "string", description: "The text of the fact. At most 4000 characters." },
			},
			required: ["key", "text"],
		},
	});
}

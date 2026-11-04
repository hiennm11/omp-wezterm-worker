/**
 * The agent that a session runs.
 *
 * OMP loads the extension again for a subagent in the same process. The
 * runtime lives at module scope, so the second load shares it. A subagent
 * must not take the authority of the main session.
 *
 * The host gives the kind of the agent to every handler. A host without that
 * field runs an older version of OMP, so the extension treats the missing
 * field as the main agent.
 */

import type { AgentDescriptor } from "./host.ts";

export type { AgentDescriptor } from "./host.ts";

/** The refusal for a control tool called by a subagent. */
export const SUBAGENT_CONTROL_REFUSAL =
	"A subagent cannot control a worker. Call this tool from the main session.";

/** Return a refusal when the caller is a subagent. */
export function subagentControlRefusal(ctx: { agent?: AgentDescriptor } | undefined): string | null {
	return isSubagent(ctx) ? SUBAGENT_CONTROL_REFUSAL : null;
}

/** The part of the context that names the agent and the session. */
export interface AgentContext {
	/** The agent that this session runs. A host without the field is older. */
	agent?: AgentDescriptor;
	/** The read-only view of the session. */
	sessionManager?: { getSessionId?: () => string | null | undefined };
}

/**
 * The kind of the agent of a session.
 *
 * The function returns "sub" only when the host names a subagent. Every
 * other case returns "main", because a host without the field runs an older
 * version of OMP that knows no subagent.
 */
export function agentKind(ctx: AgentContext | undefined): "main" | "sub" {
	return ctx?.agent?.kind === "sub" ? "sub" : "main";
}

/**
 * Whether the session runs a subagent.
 *
 * A subagent loads the extension again in the same process. It must not bind
 * the runtime, and it must not stop the monitors of the main session.
 */
export function isSubagent(ctx: AgentContext | undefined): boolean {
	return agentKind(ctx) === "sub";
}

/**
 * The line that names the session and the agent of a session start.
 *
 * The line makes the real value visible, because no log showed the kind of
 * the agent before. A host without a session manager gives "-".
 */
export function sessionStartLine(ctx: AgentContext): string {
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "-";
	return `[wezterm-worker] session_start: kind=${agentKind(ctx)} id=${ctx.agent?.id ?? "-"} session=${sessionId}`;
}

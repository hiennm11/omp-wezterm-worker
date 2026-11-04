/**
 * The event context that a test host gives to a handler.
 *
 * The context names the session and the agent. The agent tells the extension
 * which session it runs. A main session keeps the authority of its workers.
 * A subagent must not take it.
 */

import type { AgentDescriptor } from "../extensions/lib/subagent.ts";

/**
 * The event context the host passes to a `session_start` handler.
 *
 * A host without an agent runs a previous version of OMP. The context then
 * holds no agent at all.
 */
export function sessionContext(cwd: string, sessionId?: string, agent?: AgentDescriptor): unknown {
	return {
		cwd,
		sessionManager: sessionId ? { getSessionId: () => sessionId } : undefined,
		...(agent ? { agent } : {}),
		setInterval(fn: () => void, ms: number) {
			const handle = setInterval(fn, ms);
			handle.unref?.();
			return handle;
		},
		clearTimer(handle: NodeJS.Timeout) {
			clearInterval(handle);
		},
	};
}

/**
 * The pane session of the extension.
 *
 * The extension needs a pane runtime. Herdr runs only inside a session and
 * sets the variable HERDR_ENV in every pane of that session. WezTerm sets the
 * variable WEZTERM_PANE in every pane of its session.
 *
 * The extension never starts a Herdr server. A spawn outside a session is
 * refused, because no pane can open there.
 */

import { type PaneRuntimeSetting, runtimeRefusal } from "./pane-runtime.ts";

/**
 * The reason that a spawn must not start, or null when it may start.
 *
 * The function is pure. It takes the environment of the process and it reads
 * no pane and no file. A test checks it without a terminal.
 */
export function paneSessionRefusal(
	env: NodeJS.ProcessEnv,
	configured: PaneRuntimeSetting,
): string | null {
	return runtimeRefusal(env, configured);
}

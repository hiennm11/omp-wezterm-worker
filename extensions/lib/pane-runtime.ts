/**
 * The pane runtime of a worker.
 *
 * The extension can open a worker pane through Herdr or through WezTerm. A
 * configuration key selects one runtime. The environment selects one runtime
 * when the key is absent or holds `auto`.
 *
 * A worker keeps the runtime that started it. A tool that acts on that worker
 * later uses the same runtime, so a pane id is never read with the wrong CLI.
 *
 * The functions here are pure. They read no pane and no process. A test checks
 * them without a terminal.
 */

/** The program that opens the pane of a worker. */
export type PaneRuntime = "herdr" | "wezterm";

/** The value of the configuration key that lets the environment select the runtime. */
export type PaneRuntimeSetting = PaneRuntime | "auto";

/** The variable that Herdr sets in every pane of its session. */
export const HERDR_ENV_VAR = "HERDR_ENV";

/** The variable that WezTerm sets in every pane of its session. */
export const WEZTERM_PANE_VAR = "WEZTERM_PANE";

/**
 * The runtime that the extension must use, or null when no runtime exists.
 *
 * A configured runtime wins. The value `auto` reads the environment. The
 * variable `HERDR_ENV` with the value `1` names Herdr. A non-empty variable
 * `WEZTERM_PANE` names WezTerm. No signal gives null.
 *
 * Herdr wins when both variables are set, because Herdr starts its own
 * terminal and the extension talks to the session of the user.
 */
export function selectPaneRuntime(
	env: NodeJS.ProcessEnv,
	configured: PaneRuntimeSetting,
): PaneRuntime | null {
	if (configured === "herdr" || configured === "wezterm") return configured;
	if (env[HERDR_ENV_VAR] === "1") return "herdr";
	if (env[WEZTERM_PANE_VAR]) return "wezterm";
	return null;
}

/**
 * The reason that a spawn must not start, or null when it may start.
 *
 * The function is pure. It takes the environment of the process and it reads
 * no pane and no file. The message names both runtimes and both variables, so
 * the user knows every way to give the extension a pane runtime.
 */
export function runtimeRefusal(env: NodeJS.ProcessEnv, configured: PaneRuntimeSetting): string | null {
	if (selectPaneRuntime(env, configured) !== null) return null;
	return (
		`The extension opens worker panes through Herdr or WezTerm, and this process runs outside both. ` +
		`Start the session from Herdr, so the variable ${HERDR_ENV_VAR} is set, or from WezTerm, ` +
		`so the variable ${WEZTERM_PANE_VAR} is set.`
	);
}

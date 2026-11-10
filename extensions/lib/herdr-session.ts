/**
 * The Herdr session of the extension.
 *
 * Herdr runs only inside a session. Herdr sets the variable HERDR_ENV in
 * every pane of that session, so the variable tells the extension that a
 * pane runtime exists.
 *
 * The extension never starts a Herdr server. A spawn outside a session is
 * refused, because no pane can open there.
 */

/** The variable that Herdr sets in every pane of its session. */
export const HERDR_ENV_VAR = "HERDR_ENV";

/**
 * The reason that a spawn must not start, or null when it may start.
 *
 * The function is pure. It takes the environment of the process and it
 * reads no pane and no file. A test checks it without a Herdr session.
 */
export function herdrSessionRefusal(env: NodeJS.ProcessEnv): string | null {
	if (env[HERDR_ENV_VAR] === "1") return null;
	return (
		`The extension opens worker panes through Herdr, and this process runs outside a Herdr session. ` +
		`Start the session from Herdr, so the variable ${HERDR_ENV_VAR} is set.`
	);
}

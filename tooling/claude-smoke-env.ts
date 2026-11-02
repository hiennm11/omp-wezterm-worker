/**
 * The environment of the Claude smoke test.
 *
 * The extension decides its role from the environment. A process that runs
 * inside a worker holds the variables of that worker, so the extension
 * registers only the report tool. The smoke test runs as a main session, so
 * it removes those variables before the extension loads.
 *
 * The module must load before the extension. The import order of the
 * modules of the smoke test gives that.
 */

/** The variables that make the extension a worker. */
const WORKER_VARIABLES = ["OMP_WORKER_SESSION_DIR", "PI_SESSION_FILE"];

/**
 * Remove the variables of a worker from the environment.
 *
 * The function runs before the extension loads. The variables name the
 * session of a worker, and the extension would then register only the
 * report tool. The smoke test needs the tools of a main session.
 */
export function clearWorkerEnvironment(): void {
	for (const name of WORKER_VARIABLES) delete process.env[name];
}

clearWorkerEnvironment();

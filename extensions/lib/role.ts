/**
 * The worker bootstrap.
 *
 * A worker is a separate OMP process that loads the same extension. It must
 * not supervise other workers. It must not restore monitors. It must not
 * deliver the events of the main session.
 *
 * The bootstrap decides which role this process has. The role comes from the
 * session directory of the process, because the launch writes the run
 * context there.
 */

import { readRunContext } from "./worker-context.ts";

/**
 * The role of a process.
 *
 * The main role supervises workers. The worker role reports its own task.
 */
export type ProcessRole = "main" | "worker";

/**
 * The role of this process, and the run that it belongs to.
 *
 * A process is a worker when its session directory holds a run context. The
 * launch writes that file before the pane starts.
 */
export function detectRole(sessionDir: string | null): { role: ProcessRole; runId: string | null } {
	if (!sessionDir) return { role: "main", runId: null };
	const context = readRunContext(sessionDir);
	if (!context) return { role: "main", runId: null };
	return { role: "worker", runId: context.runId };
}

/**
 * The session directory of this process.
 *
 * The launch sets the variable `OMP_WORKER_SESSION_DIR` for a worker. The
 * host sets the variable `PI_SESSION_FILE` for any session. The host value
 * holds the file, so the directory comes from it.
 */
export function ownSessionDir(env: NodeJS.ProcessEnv = process.env): string | null {
	const workerDir = env.OMP_WORKER_SESSION_DIR;
	if (workerDir) return workerDir;
	const file = env.PI_SESSION_FILE;
	if (!file) return null;
	return file.replace(/[\\/][^\\/]+\.jsonl$/, "");
}

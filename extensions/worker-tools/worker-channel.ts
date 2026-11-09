/**
 * The channel of the calling worker.
 *
 * A worker reads and writes only its own channel. The channel lives in the
 * session directory of the worker, so no parameter points at another worker.
 */

import { dirname } from "node:path";

import { channelBackendRefusal } from "../lib/channel-model.ts";

/**
 * The session directory of the calling worker.
 *
 * The host sets the variable `PI_SESSION_FILE` for the session that the
 * process runs. The worker writes its transcript there. The launch sets the
 * variable `OMP_WORKER_SESSION_DIR` for a worker of this extension.
 */
export function workerSessionDir(): string | null {
	const workerDir = process.env.OMP_WORKER_SESSION_DIR;
	if (workerDir) return workerDir;
	const file = process.env.PI_SESSION_FILE;
	if (!file) return null;
	return dirname(file);
}

/**
 * The reason that the backend of the worker has no channel, or null.
 *
 * The worker tool uses it, because a Claude Code worker and a Codex worker
 * have no channel today.
 */
export function workerChannelRefusal(backend: string | undefined): string | null {
	return channelBackendRefusal(backend ?? "omp");
}

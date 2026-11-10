/**
 * The backend of a worker.
 *
 * A worker runs in the CLI that the user selected. The OMP backend keeps the
 * current behavior. The Claude backend runs a real Claude Code session in a
 * pane. The Codex backend was removed. See ADR 0026.
 *
 * A run that the database holds without a backend field is an OMP run. The
 * migration never guesses a different backend.
 */

/** The CLI that executes a worker. */
export type WorkerBackend = "omp" | "claude";

/** The value that a run of the removed backend still holds. */
export const REMOVED_BACKEND = "codex";

/**
 * The value that the column `payload` of a run row holds.
 *
 * The value `codex` names a backend that no longer exists. A run row that
 * holds it must still load, and it must never look like a run of OMP.
 */
export type RunBackend = WorkerBackend | typeof REMOVED_BACKEND;

/** The backends that the extension can start today. */
export const IMPLEMENTED_BACKENDS: WorkerBackend[] = ["omp", "claude"];

/** The backends that a spawn may name. */
export const KNOWN_BACKENDS: WorkerBackend[] = ["omp", "claude"];

/**
 * The backend of a run.
 *
 * A missing value means OMP. A value that the extension does not know is
 * read as OMP too, because the old run was an OMP run. The value `codex`
 * stays, because a run of the removed backend must never look like a run of
 * OMP.
 */
export function readBackend(job: { backend?: unknown }): RunBackend {
	const value = job.backend;
	if (value === "claude") return "claude";
	if (value === REMOVED_BACKEND) return REMOVED_BACKEND;
	return "omp";
}

/** True when the run used the backend that was removed. */
export function isRemovedBackend(job: { backend?: unknown }): boolean {
	return job.backend === REMOVED_BACKEND;
}

/** The name of a backend, for the messages of the tools. */
export function backendLabel(backend: RunBackend): string {
	if (backend === "claude") return "Claude Code";
	if (backend === REMOVED_BACKEND) return "Codex";
	return "OMP";
}

/**
 * The reason that a backend cannot start, or null when it can.
 *
 * A run that names a backend that is not implemented is refused. The
 * extension never falls back to OMP, because a silent fallback would run a
 * different program than the user asked for.
 */
export function backendRefusal(backend: WorkerBackend): string | null {
	if (IMPLEMENTED_BACKENDS.includes(backend)) return null;
	return (
		`The backend '${backend}' is not implemented. ` +
		`Use one of: ${IMPLEMENTED_BACKENDS.join(", ")}. The extension never falls back to another backend.`
	);
}

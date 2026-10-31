/**
 * The backend of a worker.
 *
 * A worker runs in the CLI that the user selected. The OMP backend keeps the
 * current behavior. The Claude backend runs a real Claude Code session in a
 * pane. The Codex backend runs a real Codex app server and a Codex TUI in two
 * panes.
 *
 * A run that the database holds without a backend field is an OMP run. The
 * migration never guesses a different backend.
 */

/** The CLI that executes a worker. */
export type WorkerBackend = "omp" | "claude" | "codex";

/** The backends that the extension can start today. */
export const IMPLEMENTED_BACKENDS: WorkerBackend[] = ["omp", "claude", "codex"];

/** The backends that a spawn may name. */
export const KNOWN_BACKENDS: WorkerBackend[] = ["omp", "claude", "codex"];

/**
 * The backend of a run.
 *
 * A missing value means OMP. A value that the extension does not know is
 * read as OMP too, because the old run was an OMP run.
 */
export function readBackend(job: { backend?: unknown }): WorkerBackend {
	const value = job.backend;
	if (value === "claude") return "claude";
	if (value === "codex") return "codex";
	return "omp";
}

/** The name of a backend, for the messages of the tools. */
export function backendLabel(backend: WorkerBackend): string {
	if (backend === "claude") return "Claude Code";
	if (backend === "codex") return "Codex";
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

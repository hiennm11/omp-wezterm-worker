/**
 * The run context of a worker.
 *
 * A worker is a separate OMP process. It must know which run it belongs to.
 * The launch writes a context file into the session directory. The worker
 * bootstrap reads that file. The file names the run, so a report binds to
 * the run that produced it.
 *
 * Only one run writes into a session directory at a time. The resource group
 * keeps a second writer out.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The name of the context file inside the session directory. */
export const CONTEXT_FILE = ".wezterm-worker-run.json";

/** The context of one run. */
export interface RunContext {
	/** The id of the run. A report carries this id. */
	runId: string;
	/** The id of the run that this run resumes, when it resumes one. */
	sourceRunId: string | null;
	/** The id of the resource group that holds the shared resources. */
	resourceGroup: string;
}

/** The path of the context file of a session directory. */
export function contextFile(sessionDir: string): string {
	return join(sessionDir, CONTEXT_FILE);
}

/** Write the context of a run into its session directory. */
export function writeRunContext(sessionDir: string, context: RunContext): void {
	writeFileSync(contextFile(sessionDir), JSON.stringify(context), "utf8");
}

/**
 * Read the context of a run from its session directory.
 *
 * A missing file or a malformed file gives null. The caller then refuses the
 * report, because an unbound report proves nothing.
 */
export function readRunContext(sessionDir: string): RunContext | null {
	let raw: string;
	try {
		raw = readFileSync(contextFile(sessionDir), "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const value = parsed as Partial<RunContext>;
	if (typeof value.runId !== "string" || !value.runId) return null;
	return {
		runId: value.runId,
		sourceRunId: typeof value.sourceRunId === "string" ? value.sourceRunId : null,
		resourceGroup: typeof value.resourceGroup === "string" ? value.resourceGroup : "",
	};
}

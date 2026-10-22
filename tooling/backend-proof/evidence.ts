/**
 * The evidence of one backend proof.
 *
 * Every observation is appended once. The verdict file records the result of
 * each scenario. The private evidence stays in the directory that the user
 * chose. The redacted report holds only the fields that a reader needs.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The result of one scenario. */
export type Verdict = "pass" | "fail" | "unavailable";

/** One observation of a native program. */
export interface Observation {
	/** The backend that produced the observation. */
	backend: string;
	/** The proof run that holds the observation. */
	runId: string;
	/** The scenario that recorded the observation. */
	scenario: string;
	/** The time of the observation, in epoch milliseconds. */
	at: number;
	/** The native event or call that produced the observation. */
	source: string;
	/** The native payload, unchanged. */
	payload: unknown;
}

/** The state of the evidence of one proof run. */
export interface EvidenceStore {
	/** The directory that holds the evidence. */
	dir: string;
	/** The backend under proof. */
	backend: string;
	/** The proof run id. */
	runId: string;
	/** Append one observation. */
	observe: (scenario: string, source: string, payload: unknown, runId?: string) => Observation;
	/** Record the result of one scenario. */
	verdict: (scenario: string, verdict: Verdict, detail: string) => void;
	/** Write the versions of the installed programs. */
	versions: (data: Record<string, unknown>) => void;
	/** Write a raw native record. */
	raw: (name: string, content: string) => void;
	/** The results of the scenarios, in the order they ran. */
	results: () => Array<{ scenario: string; verdict: Verdict; detail: string }>;
}

/** The file that holds the observations of a run. */
export function observationsFile(dir: string): string {
	return join(dir, "observations.jsonl");
}

/** The file that holds the verdicts of a run. */
export function verdictFile(dir: string): string {
	return join(dir, "verdict.json");
}

/** The file that holds the versions of the installed programs. */
export function versionsFile(dir: string): string {
	return join(dir, "versions.json");
}

/** The ids of the observations that a run already holds. */
function readSeenIds(dir: string): Set<string> {
	const seen = new Set<string>();
	try {
		for (const line of readFileSync(observationsFile(dir), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as { id?: string };
				if (parsed.id) seen.add(parsed.id);
			} catch {
				/* a partial line is normal while the file is written */
			}
		}
	} catch {
		/* the file does not exist yet */
	}
	return seen;
}

/**
 * Create the evidence store of one proof run.
 *
 * The store keeps the ids of the observations that it holds. A repeated id is
 * not appended twice, so a repeated observation never starts a second cycle.
 */
export function createEvidenceStore(dir: string, backend: string, runId: string): EvidenceStore {
	mkdirSync(dir, { recursive: true });
	const seen = readSeenIds(dir);
	const results: Array<{ scenario: string; verdict: Verdict; detail: string }> = [];
	let sequence = 0;

	function observe(scenario: string, source: string, payload: unknown, ownRunId?: string): Observation {
		sequence += 1;
		const owner = ownRunId ?? runId;
		const id = `${backend}-${owner}-${scenario}-${sequence}`;
		const observation: Observation = { backend, runId: owner, scenario, at: Date.now(), source, payload };
		if (seen.has(id)) return observation;
		seen.add(id);
		const line = JSON.stringify({ id, ...observation });
		appendFileSync(observationsFile(dir), `${line}\n`, "utf8");
		return observation;
	}

	function writeVerdicts(): void {
		writeFileSync(verdictFile(dir), `${JSON.stringify({ backend, runId, results }, null, 2)}\n`, "utf8");
	}

	return {
		dir,
		backend,
		runId,
		observe,
		verdict(scenario, verdict, detail) {
			results.push({ scenario, verdict, detail });
			writeVerdicts();
		},
		versions(data) {
			writeFileSync(versionsFile(dir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
		},
		raw(name, content) {
			writeFileSync(join(dir, name), content, "utf8");
		},
		results: () => results.map((r) => ({ ...r })),
	};
}

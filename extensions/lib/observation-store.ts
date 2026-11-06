/**
 * The store of durable native observations for a session directory.
 *
 * The run id keeps observations from a resumed worker apart from its source run.
 */

import { readFileSync } from "node:fs";

import type { BridgeObservation } from "./claude-bridge.ts";

/** The observation file of one run. */
export function observationFile(sessionDir: string, runId: string): string {
	return `${sessionDir}/.wezterm-worker-observations-${runId}.jsonl`;
}

/** Read observations of one run in file order. */
export function readObservations(sessionDir: string, runId: string): BridgeObservation[] {
	let raw: string;
	try {
		raw = readFileSync(observationFile(sessionDir, runId), "utf8");
	} catch {
		return [];
	}
	const observations: BridgeObservation[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const observation = JSON.parse(line) as BridgeObservation;
			if (observation?.runId !== runId || typeof observation.source !== "string") continue;
			observations.push(observation);
		} catch {
			/* a partial line is normal while the file is written */
		}
	}
	return observations;
}

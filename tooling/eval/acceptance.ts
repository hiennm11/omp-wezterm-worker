/**
 * The acceptance of the worker eval.
 *
 * The module holds two decisions. The first turns the evidence of one run
 * into an acceptance verdict. The second restores the protected paths of a
 * run fixture from the template fixture of the dataset.
 *
 * The acceptance verdict is a pure function of the evidence. The status of
 * the job never enters it. A cancelled run with a failing verifier is a
 * `FAIL`, because the environment could evaluate the code.
 */

import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { VerifierResult } from "./types.ts";

/** The verdict of one run. */
export type AcceptanceVerdict = "PASS" | "FAIL" | "BLOCKED";

/** The evidence that one run produced. */
export interface AcceptanceEvidence {
	workerStarted: boolean;
	fixtureCopied: boolean;
	verifier: VerifierResult;
}

/** The acceptance verdict and the reason of the verdict. */
export interface AcceptanceResult {
	verdict: AcceptanceVerdict;
	reason: string;
}

/** The result of the restore of the protected paths. */
export interface RestoreResult {
	restored: string[];
	missing: string[];
}

/**
 * The acceptance verdict of one run.
 *
 * The function returns the first rule that matches. The order of the rules
 * matters. A run without a worker or without a fixture cannot be judged, so
 * it is `BLOCKED`. A run with a verifier that reports an exit code is
 * `PASS` when the code is 0 and `FAIL` otherwise.
 */
export function acceptanceVerdict(evidence: AcceptanceEvidence): AcceptanceResult {
	if (!evidence.workerStarted) {
		return { verdict: "BLOCKED", reason: "the worker did not start" };
	}
	if (!evidence.fixtureCopied) {
		return { verdict: "BLOCKED", reason: "the fixture copy failed" };
	}
	if (!evidence.verifier.started) {
		return { verdict: "BLOCKED", reason: "the verifier did not start" };
	}
	if (evidence.verifier.timedOut) {
		return { verdict: "BLOCKED", reason: "the verifier reached its timeout" };
	}
	const code = evidence.verifier.exitCode;
	if (code === null) {
		return { verdict: "BLOCKED", reason: "the verifier gave no exit code" };
	}
	if (code === 0) return { verdict: "PASS", reason: "" };
	return { verdict: "FAIL", reason: `the verifier exited with code ${code}` };
}

/** Every file under a path, as an absolute path. */
function listFiles(path: string): string[] {
	if (!statSync(path).isDirectory()) return [path];
	const found: string[] = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) found.push(...listFiles(child));
		else if (entry.isFile()) found.push(child);
	}
	return found;
}

/**
 * Restore the protected paths of a run fixture.
 *
 * The function copies every path from the template fixture into the run
 * fixture. It removes the target first, so a weakened test returns to the
 * content of the template. The result holds the files that the copy
 * produced and the paths that the template does not hold.
 *
 * The caller validates the paths. The function does not resolve `..` and
 * does not accept an absolute path.
 */
export function restoreProtectedPaths(
	templateFixtureDir: string,
	runFixtureDir: string,
	paths: string[],
): RestoreResult {
	const restored: string[] = [];
	const missing: string[] = [];
	for (const path of paths) {
		const source = join(templateFixtureDir, path);
		if (!existsSync(source)) {
			missing.push(path);
			continue;
		}
		const target = join(runFixtureDir, path);
		rmSync(target, { recursive: true, force: true });
		cpSync(source, target, { recursive: true });
		for (const file of listFiles(target)) {
			restored.push(relative(runFixtureDir, file).split(sep).join("/"));
		}
	}
	restored.sort();
	return { restored, missing };
}

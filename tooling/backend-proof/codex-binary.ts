/**
 * The search of the Codex program of the machine.
 *
 * The proof must start the real Codex program. A shell cannot do that,
 * because the arguments of the app server would reach the shell first. The
 * search therefore returns paths of programs only.
 */

import { existsSync } from "node:fs";
import { codexBinaryCandidates, npmRootOfWhereOutput } from "../../extensions/lib/codex-binary.ts";
import type { CodexBinary } from "./codex-handle.ts";
import { runProgram } from "./shared.ts";

export { codexBinaryCandidates, npmRootOfWhereOutput };

/**
 * Find the Codex program of the machine.
 *
 * The search starts with the command `where codex`, because it names the
 * folder of npm that holds the program. The proof checks each candidate with
 * the argument `--version`. It returns null when no candidate runs, so the
 * runner reports the backend as unavailable.
 */
export async function findCodexBinary(): Promise<CodexBinary | null> {
	const located = await runProgram("where.exe", ["codex"]);
	const whereOutput = located.stdout;
	const candidates = codexBinaryCandidates(whereOutput, npmRootOfWhereOutput(whereOutput));
	for (const bin of candidates) {
		if (!existsSync(bin)) continue;
		const result = await runProgram(bin, ["--version"]);
		if (result.code === 0) return { bin, version: result.stdout.trim() };
	}
	return null;
}

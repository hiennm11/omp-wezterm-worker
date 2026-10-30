/**
 * The search of the Codex program of the machine.
 *
 * The proof must start the real Codex program. A shell cannot do that,
 * because the arguments of the app server would reach the shell first. The
 * search therefore returns paths of programs only.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodexBinary } from "./codex-handle.ts";
import { runProgram } from "./shared.ts";

/** The old fixed path of the proof. It stays a candidate. */
export const LEGACY_CODEX_PATH =
	"C:/Program Files/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

/** The vendor folder of the Codex program inside its npm package. */
const VENDOR_PATH = ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"];

/** The name of the npm package that holds the Codex program. */
const CODEX_PACKAGE = ["node_modules", "@openai", "codex"];

/** The name of the npm package that holds the Codex program for Windows. */
const WINDOWS_PACKAGE = ["node_modules", "@openai", "codex-win32-x64"];

/**
 * Build the paths of the Codex program that a folder of npm can hold.
 *
 * The npm package of Codex carries the program of Windows in its own
 * `node_modules` folder. A global install can also hold that package at the
 * top of the npm folder. Both paths are candidates.
 */
function candidatesOfFolder(folder: string): string[] {
	return [
		join(folder, ...CODEX_PACKAGE, ...WINDOWS_PACKAGE, ...VENDOR_PATH),
		join(folder, ...CODEX_PACKAGE.slice(0, 2), ...WINDOWS_PACKAGE.slice(2), ...VENDOR_PATH),
	];
}

/**
 * The folders that the output of `where codex` names.
 *
 * The command prints the path of every program of the name. The folder of a
 * printed path is a folder of npm.
 */
function foldersOfWhereOutput(whereOutput: string): string[] {
	const folders: string[] = [];
	for (const line of whereOutput.split(/\r?\n/)) {
		const path = line.trim();
		if (!path) continue;
		const folder = dirname(path);
		if (!folders.includes(folder)) folders.push(folder);
	}
	return folders;
}

/**
 * The folder of npm that the output of `where codex` names.
 *
 * The command prints the file `codex.cmd` of the npm folder. Its folder is
 * the root of npm. The function returns an empty string when the command
 * printed nothing.
 */
export function npmRootOfWhereOutput(whereOutput: string): string {
	const folders = foldersOfWhereOutput(whereOutput);
	return folders[0] ?? "";
}

/**
 * The paths of the Codex program that the machine can hold.
 *
 * The function takes the output of the command `where codex` and the root of
 * the npm folder. It returns the paths of the program, and the old fixed
 * path at the end. It never returns a shell.
 */
export function codexBinaryCandidates(whereOutput: string, npmRoot: string): string[] {
	const folders = foldersOfWhereOutput(whereOutput);
	if (npmRoot && !folders.includes(npmRoot)) folders.push(npmRoot);
	const candidates: string[] = [];
	for (const folder of folders) {
		for (const candidate of candidatesOfFolder(folder)) {
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
	}
	if (!candidates.includes(LEGACY_CODEX_PATH)) candidates.push(LEGACY_CODEX_PATH);
	return candidates;
}

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

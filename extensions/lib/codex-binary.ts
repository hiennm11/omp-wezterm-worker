/**
 * The Codex program of the machine.
 *
 * A Codex worker runs the real Codex program. A shell cannot run it, because
 * the arguments of the app server would reach the shell first. The search
 * therefore returns paths of programs only.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { RunFn } from "./process.ts";

/** The old fixed path of the proof. It stays a candidate. */
export const LEGACY_CODEX_PATH =
	"C:/Program Files/nodejs/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

/** The vendor folder of the Codex program inside its npm package. */
const VENDOR_PATH = ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"];

/** The name of the npm package that holds the Codex program. */
const CODEX_PACKAGE = ["node_modules", "@openai", "codex"];

/** The name of the npm package that holds the Codex program for Windows. */
const WINDOWS_PACKAGE = ["node_modules", "@openai", "codex-win32-x64"];

/** The lowest version of the Codex program that the extension supports. The full proof passed on this version. */
export const MIN_CODEX_VERSION = "0.166.0";

/** The Codex program of the machine. */
export interface CodexBinary {
	/** The path of the program. */
	bin: string;
	/** The version of the program, or null when the program holds no version. */
	version: string | null;
}

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
 * The version of the Codex program, or null when the text holds no version.
 *
 * The program prints a line such as `codex-cli 0.147.0`. The function reads
 * the three numbers of that line. A text without such numbers gives null.
 */
export function parseCodexVersion(versionText: string): string | null {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionText);
	if (!match) return null;
	return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * The reason that the version of the Codex program is not enough, or null.
 *
 * The function returns null when the version is at least the minimum. A
 * version that is lower, a version that the parser cannot read and a missing
 * version give a text that names the version that was found and the minimum.
 */
export function codexVersionRefusal(versionText: string | null): string | null {
	const version = versionText === null ? null : parseCodexVersion(versionText);
	if (version === null) {
		const found = versionText === null ? "no version" : `the version '${versionText}'`;
		return (
			`The Codex program reports ${found}, which the extension cannot read. ` +
			`The extension needs version ${MIN_CODEX_VERSION} or later.`
		);
	}
	if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
		return (
			`The Codex program is version ${version}. ` +
			`The extension needs version ${MIN_CODEX_VERSION} or later.`
		);
	}
	return null;
}

/**
 * Compare two versions of the Codex program.
 *
 * The function gives a negative number when the first version is lower, zero
 * when both are the same and a positive number when the first is higher.
 */
function compareVersions(left: string, right: string): number {
	const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Find the Codex program of the machine.
 *
 * An absolute path to a file is the program. Any other name is looked up
 * with the command `where`, and the candidates come from the output of that
 * command. The function checks each candidate with the argument `--version`.
 * It returns null when no candidate runs, so the caller reports the backend
 * as unavailable.
 */
export async function findCodexBinary(exec: RunFn, codexBin: string): Promise<CodexBinary | null> {
	for (const candidate of await candidatesOf(exec, codexBin)) {
		if (!existsSync(candidate)) continue;
		const result = await exec(candidate, ["--version"]);
		if (result.code === 0) return { bin: candidate, version: result.stdout.trim() };
	}
	return null;
}

/**
 * The candidates of the Codex program for one name.
 *
 * An absolute path is the only candidate. Any other name gives the output of
 * the command `where`, and the candidates come from that output.
 */
async function candidatesOf(exec: RunFn, codexBin: string): Promise<string[]> {
	if (isAbsolute(codexBin)) return [codexBin];
	const located = await exec("where.exe", [codexBin]);
	const whereOutput = located.stdout;
	return codexBinaryCandidates(whereOutput, npmRootOfWhereOutput(whereOutput));
}

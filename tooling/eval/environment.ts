/**
 * The environment of the machine.
 *
 * The module reads the version of node, the platform, the architecture and
 * the version of the programs that the benchmark uses. The manifest of a run
 * holds the result.
 */

import { spawnSync } from "node:child_process";
import { arch, platform } from "node:os";

/** The names of the programs whose version the environment holds. */
const VERSION_PROGRAMS = ["omp", "herdr", "wezterm"];

/** The version of a program, or null when the program cannot run. */
function programVersion(name: string): string | null {
	const probe = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true });
	if (probe.status !== 0) return null;
	const text = probe.stdout.trim();
	return text.length > 0 ? text : null;
}

/**
 * The environment of the machine.
 *
 * The environment holds the version of node, the platform, the
 * architecture and the version of every program that runs. A program that
 * cannot run is left out.
 */
export function machineEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {
		node: process.version,
		platform: platform(),
		arch: arch(),
	};
	for (const program of VERSION_PROGRAMS) {
		const version = programVersion(program);
		if (version !== null) environment[program] = version;
	}
	return environment;
}

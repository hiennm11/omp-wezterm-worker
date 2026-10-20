/**
 * The extension's configuration.
 *
 * A config file holds the defaults for every worker; the environment wins
 * over the file, so a caller can retarget the binaries or the state
 * directory without editing anything on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Placement = "split" | "tab";

export interface WorkerConfig {
	ompBin: string;
	weztermBin: string;
	placement: Placement;
	stateDir: string;
	defaultCwd: string;
	model: string | null;
	tools: string[] | null;
	pollMs: number;
	timeoutMs: number;
	/** Fail a worker that produced no transcript activity for this long. 0 disables. */
	idleTimeoutMs: number;
	isolated: boolean;
	/** Close the worker pane when the worker finishes. */
	closePaneOnFinish: boolean;
	/** Refuse a launch when this many workers are active. 0 means no limit. */
	maxActiveWorkers: number;
	/** Refuse a launch after this many launches since the last user prompt. 0 means no limit. */
	maxLaunchesPerRequest: number;
}

export const DEFAULT_CONFIG: WorkerConfig = {
	ompBin: "omp",
	weztermBin: "wezterm",
	placement: "split",
	stateDir: join(homedir(), ".omp", "agent", "wezterm-workers"),
	defaultCwd: process.cwd(),
	model: null,
	tools: null,
	pollMs: 2000,
	timeoutMs: 30 * 60 * 1000,
	idleTimeoutMs: 0,
	isolated: false,
	closePaneOnFinish: true,
	maxActiveWorkers: 1,
	maxLaunchesPerRequest: 3,
};

/** Static string-keyed table: config key -> the config field it overrides. */
const CONFIG_STRING_KEYS = ["ompBin", "weztermBin", "stateDir", "defaultCwd"] as const;
const CONFIG_NUMBER_KEYS = [
	"pollMs",
	"timeoutMs",
	"idleTimeoutMs",
	"maxActiveWorkers",
	"maxLaunchesPerRequest",
] as const;
const CONFIG_BOOLEAN_KEYS = ["isolated", "closePaneOnFinish"] as const;

export function defaultConfigFile(): string {
	return join(homedir(), ".omp", "agent", "wezterm-worker.json");
}

/**
 * Read the config.
 *
 * A missing or malformed file leaves the defaults in place. Every value is
 * type-checked before it is applied, so a wrong type in the file cannot
 * break the extension.
 *
 * `env` is passed in so a test does not have to mutate the process
 * environment.
 */
export function loadConfig(
	file: string = defaultConfigFile(),
	env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
	const cfg: WorkerConfig = { ...DEFAULT_CONFIG };
	try {
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			for (const key of CONFIG_STRING_KEYS) {
				const v = raw[key];
				if (typeof v === "string") cfg[key] = v;
			}
			for (const key of CONFIG_NUMBER_KEYS) {
				const v = raw[key];
				if (typeof v === "number") cfg[key] = v;
			}
			for (const key of CONFIG_BOOLEAN_KEYS) {
				const v = raw[key];
				if (typeof v === "boolean") cfg[key] = v;
			}
			if (raw.placement === "split" || raw.placement === "tab") cfg.placement = raw.placement;
			if (typeof raw.model === "string") cfg.model = raw.model;
			if (Array.isArray(raw.tools)) cfg.tools = raw.tools.map(String);
		}
	} catch {
		// A malformed config file leaves the defaults in place.
	}
	// Environment overrides win over the file so a caller can retarget binaries.
	if (env.OMP_WORKER_OMP_BIN) cfg.ompBin = env.OMP_WORKER_OMP_BIN;
	if (env.OMP_WORKER_WEZTERM_BIN) cfg.weztermBin = env.OMP_WORKER_WEZTERM_BIN;
	if (env.OMP_WORKER_STATE_DIR) cfg.stateDir = env.OMP_WORKER_STATE_DIR;
	return cfg;
}

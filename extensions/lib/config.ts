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

import type { CommsSettings } from "./comms-check.ts";

export type Placement = "split" | "tab";

export interface WorkerConfig {
	ompBin: string;
	/** The binary of Claude Code. A Claude worker runs this program. */
	claudeBin: string;
	/** The binary of Codex. A Codex worker runs this program. */
	codexBin: string;
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
	/** The settings of the communication check. */
	commsStandard: CommsSettings;
	/** The folder of the ste100 skill. The checker of the skill scores every text. */
	ste100Skill: string;
}

export const DEFAULT_CONFIG: WorkerConfig = {
	ompBin: "omp",
	claudeBin: "claude",
	codexBin: "codex",
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
	maxActiveWorkers: 3,
	maxLaunchesPerRequest: 3,
	commsStandard: { mode: "warn", minScore: 80 },
	ste100Skill: join(homedir(), ".claude", "skills", "ste100"),
};

/** Static string-keyed table: config key -> the config field it overrides. */
const CONFIG_STRING_KEYS = [
	"ompBin",
	"claudeBin",
	"codexBin",
	"weztermBin",
	"stateDir",
	"defaultCwd",
] as const;
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
 * The communication settings of a config file.
 *
 * A missing or malformed value leaves the default in place. A wrong mode or a
 * wrong score cannot break the extension. A score outside the range of 0 to
 * 100 is refused. The default is used, and the guidance is collected.
 *
 * The caller gives the list that holds the guidance. A refusal must never
 * pass without a word, so every caller must pass a list.
 */
export function readCommsStandard(value: unknown, guidance: string[]): CommsSettings {
	const fallback = DEFAULT_CONFIG.commsStandard;
	if (typeof value !== "object" || value === null) return fallback;
	const raw = value as Record<string, unknown>;
	const mode = raw.mode;
	const minScore = raw.minScore;
	let score = fallback.minScore;
	if (typeof minScore === "number" && Number.isFinite(minScore)) {
		if (minScore >= MIN_SCORE_LOW && minScore <= MIN_SCORE_HIGH) {
			score = minScore;
		} else {
			// A score of 150 refuses every text. The default is used instead,
			// and the user learns about the refusal.
			guidance.push(MIN_SCORE_GUIDANCE);
		}
	}
	return {
		mode: mode === "off" || mode === "warn" || mode === "enforce" ? mode : fallback.mode,
		minScore: score,
	};
}

/**
 * The folder of the ste100 skill.
 *
 * A string sets the folder. A path that starts with `~` expands to the home
 * folder of the user. A value of another type keeps the default, because a
 * broken path must not stop the extension.
 */
export function readSkillFolder(value: unknown, fallback: string): string {
	if (typeof value !== "string" || value.length === 0) return fallback;
	if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
		return join(homedir(), value.slice(1));
	}
	return value;
}

/**
 * Read the config.
 *
 * A missing or malformed file leaves the defaults in place. Every value is
 * type-checked before it is applied, so a wrong type in the file cannot
 * break the extension.
 *
 * The variable `OMP_WORKER_CONFIG_FILE` names the config file. It applies
 * only when the caller names no file. A caller that names a file keeps that
 * file. The variable lets a test host ignore the file of the user, so the
 * result of a test does not depend on a file outside the repository.
 *
 * `env` is passed in so a test does not have to mutate the process
 * environment.
 */
export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): WorkerConfig {
	const path = file ?? env.OMP_WORKER_CONFIG_FILE ?? defaultConfigFile();
	const cfg: WorkerConfig = { ...DEFAULT_CONFIG };
	const guidance: string[] = [];
	// The guidance belongs to the last load. A load without a problem clears
	// the guidance of the load before it.
	lastGuidance = null;
	try {
		if (existsSync(path)) {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
			cfg.ste100Skill = readSkillFolder(raw.ste100Skill, cfg.ste100Skill);
			cfg.commsStandard = readCommsStandard(raw.commsStandard, guidance);
			// The idle deadline is gone. A worker is stopped by its reports
			// and by its total deadline, never by silence. A nonzero value
			// in an old config file is refused with guidance, not ignored.
			if (typeof raw.idleTimeoutMs === "number" && raw.idleTimeoutMs !== 0) {
				guidance.push(IDLE_TIMEOUT_GUIDANCE);
				cfg.idleTimeoutMs = 0;
			}
		}
	} catch {
		// A malformed config file leaves the defaults in place.
	}
	// Environment overrides win over the file so a caller can retarget binaries.
	if (env.OMP_WORKER_OMP_BIN) cfg.ompBin = env.OMP_WORKER_OMP_BIN;
	if (env.OMP_WORKER_WEZTERM_BIN) cfg.weztermBin = env.OMP_WORKER_WEZTERM_BIN;
	if (env.OMP_WORKER_STATE_DIR) cfg.stateDir = env.OMP_WORKER_STATE_DIR;
	// A file can hold more than one problem. Every message reaches the user.
	if (guidance.length > 0) lastGuidance = guidance.join(" ");
	return cfg;
}

/**
 * The guidance that the last config load produced, or null.
 *
 * The extension reports the guidance through the host logger. A setting that
 * the new release refuses must not pass without a word.
 */
export let lastGuidance: string | null = null;

/** The guidance for a config file that holds a nonzero idle deadline. */
export const IDLE_TIMEOUT_GUIDANCE =
	"The setting idleTimeoutMs is gone. A worker is stopped by its reports and by timeoutMs, " +
	"never by silence. Set idleTimeoutMs to 0 or remove it. " +
	"See docs/adr/0009-recoverable-omp-supervision.md.";

/** The lowest score that the communication check accepts. */
export const MIN_SCORE_LOW = 0;

/** The highest score that the communication check accepts. */
export const MIN_SCORE_HIGH = 100;

/** The guidance for a config file that holds a score outside the range. */
export const MIN_SCORE_GUIDANCE =
	"The setting commsStandard.minScore must be a number from 0 to 100. " +
	"A score of 150 refuses every text. The default of 80 is used instead.";

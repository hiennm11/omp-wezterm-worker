/**
 * The shared parts of the backend proof.
 *
 * The module holds the fixture, the version capture, the pane helpers and the
 * argument rules. It never touches the production launch path.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** The backends that the proof supports. */
export const BACKENDS = ["claude", "codex"] as const;

/** One backend of the proof. */
export type Backend = (typeof BACKENDS)[number];

/** The scenarios that the proof supports. */
export const SCENARIOS = [
	"observe",
	"queue",
	"direct-input",
	"approval",
	"background",
	"no-report",
	"resume",
	"recovery",
	"stop",
	"settings-usage",
	"all",
] as const;

/** One scenario of the proof. */
export type Scenario = (typeof SCENARIOS)[number];

/** The scenarios that the proof runs when the selection is `all`. */
export const FIXED_SCENARIOS: Scenario[] = [
	"observe",
	"queue",
	"direct-input",
	"approval",
	"background",
	"no-report",
	"resume",
	"recovery",
	"stop",
	"settings-usage",
];

/** The seconds that one model scenario may take. */
export const SCENARIO_LIMIT_SECONDS = 180;

/** The arguments that the proof runner accepts. */
export interface ProofArgs {
	backend: Backend;
	scenario: Scenario;
	evidenceDir: string;
}

/** The reason that the arguments are wrong. */
export class ArgumentError extends Error {}

/**
 * Read the arguments of the proof runner.
 *
 * The runner refuses a missing evidence argument, an unknown backend, and an
 * unknown scenario. It never guesses a default directory.
 */
export function parseArgs(argv: string[]): ProofArgs {
	let backend: string | null = null;
	let scenario: string | null = null;
	let evidenceDir: string | null = null;

	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--backend" && value) {
			backend = value;
			index += 1;
		} else if (flag === "--scenario" && value) {
			scenario = value;
			index += 1;
		} else if (flag === "--evidence-dir" && value) {
			evidenceDir = value;
			index += 1;
		} else {
			throw new ArgumentError(`Unknown argument: ${flag ?? ""}`);
		}
	}

	if (!backend) throw new ArgumentError("The argument --backend is required.");
	if (!BACKENDS.includes(backend as Backend)) {
		throw new ArgumentError(`The backend must be one of ${BACKENDS.join(", ")}.`);
	}
	if (!scenario) throw new ArgumentError("The argument --scenario is required.");
	if (!SCENARIOS.includes(scenario as Scenario)) {
		throw new ArgumentError(`The scenario must be one of ${SCENARIOS.join(", ")}.`);
	}
	if (!evidenceDir) throw new ArgumentError("The argument --evidence-dir is required.");
	if (!isAbsolute(evidenceDir)) {
		throw new ArgumentError("The evidence directory must be an absolute path.");
	}
	return { backend: backend as Backend, scenario: scenario as Scenario, evidenceDir: resolve(evidenceDir) };
}

/**
 * Check that the evidence directory is usable.
 *
 * The directory must not exist, or it must be empty. It must not sit inside a
 * native CLI home, because the proof writes files there.
 */
export function checkEvidenceDir(dir: string): void {
	const homes = [join(homedir(), ".claude"), join(homedir(), ".codex"), join(homedir(), ".omp")];
	for (const home of homes) {
		if (!home) continue;
		const inside = resolve(dir).startsWith(resolve(home));
		if (inside) {
			throw new ArgumentError(`The evidence directory must not sit inside the native home ${home}.`);
		}
	}
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir);
	if (entries.length > 0) {
		throw new ArgumentError(
			`The evidence directory ${dir} already holds files. The proof never overwrites old evidence.`,
		);
	}
}

/** The native home directories that the proof must not write into. */
export function nativeHomes(): string[] {
	return [join(homedir(), ".claude"), join(homedir(), ".codex")];
}

/**
 * Create the Git fixture of the proof.
 *
 * The fixture lives inside the evidence directory. The proof never runs a
 * mutation scenario in the checkout of the user.
 */
export async function makeFixture(root: string): Promise<string> {
	const dir = join(root, "fixture");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "baseline.txt"), "BASELINE\n", "utf8");
	const git = (args: string[]) =>
		new Promise<void>((resolvePromise, rejectPromise) => {
			const child = spawn("git", args, { cwd: dir, stdio: "ignore", windowsHide: true });
			child.on("error", rejectPromise);
			child.on("close", (code) => {
				if (code === 0) resolvePromise();
				else rejectPromise(new Error(`git ${args.join(" ")} failed with code ${code}`));
			});
		});
	await git(["init", "-b", "main"]);
	await git(["config", "user.email", "proof@example.invalid"]);
	await git(["config", "user.name", "Proof"]);
	await git(["add", "-A"]);
	await git(["commit", "-m", "baseline"]);
	return dir;
}

/** The result of one program run. */
export interface ProgramResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run one program and collect its output.
 *
 * The proof runs every program through this seam, so a test can replace it.
 */
export function runProgram(
	bin: string,
	args: string[],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
): Promise<ProgramResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(bin, args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (data: string) => (stdout += data));
		child.stderr.on("data", (data: string) => (stderr += data));
		child.on("error", (error: Error) => resolvePromise({ code: -1, stdout, stderr: stderr + String(error) }));
		child.on("close", (code: number | null) => resolvePromise({ code: code ?? -1, stdout, stderr }));
	});
}

/** The version of one program, or null when the program cannot run. */
export async function programVersion(bin: string, args: string[] = ["--version"]): Promise<string | null> {
	const result = await runProgram(bin, args);
	if (result.code !== 0) return null;
	return result.stdout.trim() || result.stderr.trim() || null;
}

/** The temporary directory that the proof uses for its own work. */
export function proofTempRoot(): string {
	return tmpdir();
}

/** The path of a file inside a directory. */
export function inside(dir: string, name: string): string {
	return join(dir, name);
}

/** The size of a directory in bytes, or 0 when it does not exist. */
export function directorySize(dir: string): number {
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const info = statSync(path);
		total += info.isDirectory() ? directorySize(path) : info.size;
	}
	return total;
}

/** The path separator of the machine. */
export const PATH_SEPARATOR = sep;

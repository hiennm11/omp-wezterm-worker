/**
 * Child processes.
 *
 * Every program the extension starts (omp, wezterm, git) goes through `run`,
 * so a test can replace it with a fake.
 */

import { spawn } from "node:child_process";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type RunFn = (
	bin: string,
	args: string[],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
) => Promise<RunResult>;

export const run: RunFn = (bin, args, cwd, env) => {
	const { promise, resolve: settle } = Promise.withResolvers<RunResult>();
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
	child.stdout.on("data", (d: string) => (stdout += d));
	child.stderr.on("data", (d: string) => (stderr += d));
	child.on("error", (e: Error) => settle({ code: -1, stdout, stderr: stderr + String(e) }));
	child.on("close", (code: number | null) => settle({ code: code ?? -1, stdout, stderr }));
	return promise;
};

/** The reason a command failed: its output, or its exit code when it printed nothing. */
export function describeFailure(res: RunResult): string {
	return (res.stderr || res.stdout).trim() || `exit code ${res.code}`;
}

export function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

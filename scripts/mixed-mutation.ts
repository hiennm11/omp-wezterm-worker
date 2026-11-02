/**
 * The mutation check of the tests of the mixed backends.
 *
 * The script breaks one exact string of the code under test, runs the test
 * files of the list, and restores the original bytes. It never commits the
 * mutation.
 *
 * Run it with: node scripts/mixed-mutation.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** One mutation of the code under test. */
interface Mutation {
	/** The name of the mutation. */
	name: string;
	/** The file that holds the broken string. */
	file: string;
	/** The exact string that the mutation replaces. */
	from: string;
	/** The string that replaces it. */
	to: string;
	/** The test files that must fail with the mutation. */
	tests: string[];
	/** Break every occurrence of the string instead of the first one. */
	all?: boolean;
}

/** The mutations of the check. */
const MUTATIONS: Mutation[] = [
	{
		name: "the shared pool counts the workers of every backend",
		file: "extensions/lib/limits.ts",
		from: "for (const job of jobs.values()) if (isActive(job)) active += 1;",
		to: 'for (const job of jobs.values()) if (isActive(job) && readBackend(job) === "omp") active += 1;',
		tests: ["tests/mixed-capacity.test.ts"],
	},
	{
		name: "the request counts the launches of every backend",
		file: "extensions/lib/limits.ts",
		from: "const launched = requestLaunches.filter((id) => {",
		to: 'const launched = requestLaunches.filter((id) => {\n\t\t\tconst only = jobs.get(id);\n\t\t\tif (only && readBackend(only) !== "omp") return false;',
		tests: ["tests/mixed-request.test.ts"],
	},
	{
		name: "a new prompt resets the count of the request",
		file: "extensions/lib/limits.ts",
		from: "rt.requestLaunches = [];",
		to: "rt.requestLaunches = [...rt.requestLaunches];",
		tests: ["tests/mixed-request.test.ts"],
	},
	{
		name: "the instruction of one native worker does not block the other",
		file: "extensions/lib/claude-run-state.ts",
		from: "if (state.pendingInstructions.size > 0) {",
		to: 'if (state.pendingInstructions.size > 0 && state.runId === "never") {',
		tests: ["tests/mixed-queue.test.ts"],
	},
	{
		name: "the approval of one native worker does not block the other",
		file: "extensions/lib/claude-run-state.ts",
		from: "if (state.openApprovals.size > 0) {",
		to: 'if (state.openApprovals.size > 0 && state.runId === "never") {',
		tests: ["tests/mixed-approval.test.ts"],
	},
	{
		name: "the event key names the run of the event",
		file: "extensions/lib/events.ts",
		from: "return `${runId}|${evidenceId}|${condition}`;",
		to: "return `${evidenceId}|${condition}`;".replace("${evidenceId}", "$" + "{evidenceId}"),
		tests: ["tests/mixed-events.test.ts"],
	},
	{
		name: "the handling of an event is recorded once",
		file: "extensions/lib/events.ts",
		from: "if (existing.disposition === disposition) return { ok: true, handling: existing };",
		to: "return { ok: true, handling: existing };",
		tests: ["tests/mixed-events.test.ts"],
	},
	{
		name: "the recovery of the startup attaches to the Codex worker again",
		file: "extensions/lib/reattach-codex.ts",
		from: "const resumed = await resumeThread(client, identity.threadId);",
		to: 'const resumed = { error: "the thread did not resume" };',
		tests: ["tests/mixed-recovery.test.ts"],
	},
	{
		name: "the pending stop wins over the reports of the worker",
		file: "extensions/lib/monitor.ts",
		from: "if (job.pendingStop) return stop(job.pendingStop.status, job.pendingStop.error);",
		to: "if (false) return stop(job.pendingStop.status, job.pendingStop.error);",
		tests: ["tests/mixed-stop-intent.test.ts"],
		all: true,
	},
	{
		name: "the stop intent refuses the steer of the worker",
		file: "extensions/lib/stop-reconcile.ts",
		from: "if (!pendingStopIntentOf(db, runId)) return null;",
		to: "if (true) return null;",
		tests: ["tests/mixed-stop-intent.test.ts"],
	},
	{
		name: "the resume keeps the backend of the source run",
		file: "extensions/worker-tools/resume.ts",
		from: 'backend === "omp"',
		to: 'backend === "omp" || backend === "claude"',
		tests: ["tests/mixed-resume.test.ts"],
	},
	{
		name: "the refusal of a group names the worker that holds it",
		file: "extensions/lib/groups.ts",
		from: "reason: `The resources of this task are used by run ${group.executionHolder}.`,",
		to: 'reason: "The resources of this task are used by another run.",',
		tests: ["tests/mixed-resource.test.ts"],
	},
	{
		name: "the cancel of a worker closes only its own pane",
		file: "extensions/lib/lifecycle.ts",
		from: ": await closePaneConfirmed(rt, job.paneId);",
		to: ": await closePaneConfirmed(rt, job.paneId);\n\t\t\t\tfor (const other of rt.jobs.values()) {\n\t\t\t\t\tif (other.id === job.id || other.paneId === null) continue;\n\t\t\t\t\tawait closePaneConfirmed(rt, other.paneId);\n\t\t\t\t}",
		tests: ["tests/mixed-cancel.test.ts"],
	},
	{
		name: "the cleanup refuses a run with a pending event",
		file: "extensions/worker-tools/cleanup.ts",
		from: "const pending = pendingEvents(db).filter((event) => event.runId === job.id);",
		to: "const pending = pendingEvents(db).filter(() => false);",
		tests: ["tests/mixed-cleanup.test.ts"],
	},
];

/** Run one test file and report the names of the tests that failed. */
function runTests(files: string[]): string[] {
	const env = { ...process.env };
	delete env.OMP_WORKER_SESSION_DIR;
	delete env.PI_SESSION_FILE;
	try {
		const output = execFileSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
			cwd: ROOT,
			encoding: "utf8",
			env,
		});
		return failedNames(output);
	} catch (error) {
		const output = String((error as { stdout?: string }).stdout ?? "");
		return failedNames(output);
	}
}

/** The names of the tests that failed in the output of the test runner. */
function failedNames(output: string): string[] {
	const names: string[] = [];
	for (const line of output.split("\n")) {
		const match = /^not ok \d+ - (.+)$/.exec(line);
		if (match) names.push(match[1]);
	}
	return names;
}

/**
 * Break one string of a file and restore the original bytes.
 *
 * The files of the repository use CRLF. The search uses LF, so the mutation
 * finds its string in every file.
 */
function withMutation(mutation: Mutation, run: () => void): boolean {
	const path = join(ROOT, mutation.file);
	const original = readFileSync(path);
	const text = original.toString("utf8");
	const unix = text.replace(/\r\n/g, "\n");
	if (!unix.includes(mutation.from)) return false;
	const broken = mutation.all
		? unix.replaceAll(mutation.from, mutation.to)
		: unix.replace(mutation.from, mutation.to);
	writeFileSync(path, broken.replace(/\n/g, "\r\n"), "utf8");
	try {
		run();
	} finally {
		writeFileSync(path, original);
	}
	return true;
}

/** Run the mutations and report the ones that no test caught. */
function main(): void {
	const survivors: string[] = [];
	for (const mutation of MUTATIONS) {
		let failed: string[] = [];
		const applied = withMutation(mutation, () => {
			failed = runTests(mutation.tests);
		});
		if (!applied) {
			survivors.push(`${mutation.name}: the string to break is not in ${mutation.file}`);
			console.log(`NO STRING: ${mutation.name}`);
			continue;
		}
		const status = failed.length > 0 ? "caught" : "SURVIVED";
		console.log(`${status}: ${mutation.name}`);
		for (const name of failed) console.log(`  failed: ${name}`);
		if (failed.length === 0) survivors.push(mutation.name);
	}
	if (survivors.length > 0) {
		console.log("\nMutations that no test caught:");
		for (const name of survivors) console.log(`  ${name}`);
		process.exitCode = 1;
	}
}

main();

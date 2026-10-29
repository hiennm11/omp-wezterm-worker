/**
 * The proof runner of the multi-backend worker contracts.
 *
 * The runner launches a real native session of one backend, observes its
 * events, and writes the evidence of the proof. It never changes the
 * production behavior of the extension.
 *
 * The command is:
 *
 *   node tooling/backend-proof.ts --backend <claude|codex> --scenario <name> --evidence-dir <path>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runClaudeProof } from "./backend-proof/claude-run.ts";
import { runCodexProof } from "./backend-proof/codex-run.ts";
import { findCodexBinary } from "./backend-proof/codex-server.ts";
import { createEvidenceStore, observationsFile } from "./backend-proof/evidence.ts";
import {
	ArgumentError,
	checkEvidenceDir,
	type ProofArgs,
	parseArgs,
	programVersion,
} from "./backend-proof/shared.ts";

/** The exit code of a failed scenario. */
const EXIT_FAILED = 1;

/** The exit code of a missing prerequisite. */
const EXIT_MISSING = 2;

/** Write the report of the proof. */
function writeReport(dir: string, lines: string[]): void {
	writeFileSync(join(dir, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

/** Run the proof of one backend. */
async function main(): Promise<number> {
	let args: ProofArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof ArgumentError ? error.message : String(error));
		console.error("");
		console.error("The command is:");
		console.error(
			"  node tooling/backend-proof.ts --backend <claude|codex> --scenario <name> --evidence-dir <path>",
		);
		return EXIT_MISSING;
	}

	try {
		checkEvidenceDir(args.evidenceDir);
	} catch (error) {
		console.error(error instanceof ArgumentError ? error.message : String(error));
		return EXIT_MISSING;
	}

	mkdirSync(args.evidenceDir, { recursive: true });
	const runId = `proof-${args.backend}-${Date.now().toString(36)}`;
	const observations: Array<{ source: string; payload: unknown }> = [];
	const evidence = createEvidenceStore(args.evidenceDir, args.backend, runId);

	const binary = args.backend === "codex" ? await findCodexBinary() : null;

	const versions: Record<string, unknown> = {
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		claude: await programVersion("claude"),
		codex: binary?.version ?? null,
		wezterm: await programVersion("wezterm"),
	};
	if (binary) versions.codexBinary = binary.bin;
	evidence.versions(versions);

	const report: string[] = [
		`# Backend proof: ${args.backend}`,
		"",
		`Run id: ${runId}`,
		`Scenario: ${args.scenario}`,
		"",
		"## Installed programs",
		"",
		"| Program | Version |",
		"| :- | :- |",
		`| node | ${versions.node} |`,
		`| claude | ${versions.claude ?? "not available"} |`,
		`| codex | ${versions.codex ?? "not available"} |`,
		`| wezterm | ${versions.wezterm ?? "not available"} |`,
		"",
	];

	let outcome: { verdict: string; results: Array<{ scenario: string; verdict: string; detail: string }> };
	try {
		outcome =
			args.backend === "claude"
				? await runClaudeProof({
						args,
						runId,
						evidence,
						observations,
					})
				: await runCodexProof({
						args,
						runId,
						evidence,
						observations,
						binary,
					});
	} catch (error) {
		const detail = `the run threw: ${String(error)}`;
		outcome = {
			verdict: "fail",
			results: [{ scenario: args.scenario, verdict: "fail", detail }],
		};
	}

	report.push("## Scenarios", "");
	report.push("| Scenario | Verdict | Detail |");
	report.push("| :- | :- | :- |");
	for (const result of outcome.results) {
		report.push(`| ${result.scenario} | ${result.verdict} | ${result.detail} |`);
	}
	report.push("");
	report.push(`Overall: ${outcome.verdict}`);
	report.push("");
	writeReport(args.evidenceDir, report);

	for (const result of outcome.results) {
		console.log(`${result.verdict.toUpperCase()}  ${result.scenario}: ${result.detail}`);
	}
	console.log(`Overall: ${outcome.verdict}`);
	console.log(`Evidence: ${args.evidenceDir}`);
	console.log(`Observations: ${observationsFile(args.evidenceDir)}`);

	if (outcome.verdict === "unavailable") return EXIT_MISSING;
	if (outcome.verdict !== "pass") return EXIT_FAILED;
	return 0;
}

process.exit(await main());

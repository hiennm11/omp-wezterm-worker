/**
 * The STE100 command line checker.
 *
 * Run it on the documents the agents read, so the score is a fact and not a
 * claim.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { checkDocument } from "./ste100.ts";

/** The score a document must reach. */
export const REQUIRED_SCORE = 80;

/** The documents the agents read. Their score must reach the limit. */
export const CHECKED_DOCUMENTS = [
	"AGENTS.md",
	"GLOSSARY.md",
	"README.md",
	"skills/wezterm-omp-pane-ops/SKILL.md",
	"docs/adr/0001-transcript-is-the-result-source.md",
	"docs/adr/0002-never-delete-a-workers-work.md",
	"docs/adr/0003-extension-and-script-not-a-fork.md",
	"docs/adr/0004-deliver-with-send-user-message.md",
	"docs/adr/0005-use-the-host-managed-timers.md",
	"docs/adr/0006-stopped-means-confirmed.md",
	"docs/adr/0007-limits-and-usage-enforced-in-code.md",
	"docs/trials/windows-trial.md",
];

export interface DocumentResult {
	path: string;
	score: number;
	totalSentences: number;
	findings: number;
	pass: boolean;
}

export function checkFile(path: string, root: string): DocumentResult {
	const markdown = readFileSync(path, "utf8");
	const report = checkDocument(markdown);
	return {
		path: relative(root, path).replace(/\\/g, "/"),
		score: report.score,
		totalSentences: report.totalSentences,
		findings: report.findings.length,
		pass: report.score >= REQUIRED_SCORE,
	};
}

/** Check every document and report the result. */
export function checkAll(root: string, paths: string[]): { results: DocumentResult[]; failed: number } {
	const targets = paths.length > 0 ? paths : CHECKED_DOCUMENTS.map((p) => join(root, p));
	const results = targets.map((path) => checkFile(path, root));
	return { results, failed: results.filter((r) => !r.pass).length };
}

export function main(root: string, paths: string[]): number {
	const { results, failed } = checkAll(root, paths);
	console.log(`STE100 check. The required score is ${REQUIRED_SCORE}.`);
	console.log("");
	for (const result of results) {
		const mark = result.pass ? "PASS" : "FAIL";
		console.log(
			`${mark}  ${String(result.score).padStart(3)}  ${result.path}  ` +
				`(${result.totalSentences} sentences, ${result.findings} findings)`,
		);
		if (!result.pass) {
			const report = checkDocument(readFileSync(join(root, result.path), "utf8"));
			for (const finding of report.findings.slice(0, 10)) {
				console.log(`      line ${finding.line}  ${finding.rule}  ${finding.message}`);
			}
		}
	}
	console.log("");
	if (failed > 0) {
		console.log(`${failed} document(s) below the required score.`);
		return 1;
	}
	console.log("All documents meet the required score.");
	return 0;
}

// Run only when this file is the entry point. A test imports the checks.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
	process.exit(main(process.cwd(), process.argv.slice(2)));
}

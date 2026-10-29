/**
 * The document check of this repository.
 *
 * The command runs the checker of the ste100 skill on every document that an
 * agent reads. The skill is the only checker of this repository. The command
 * gives the score of every document and fails below the minimum score.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPORTING_CONTRACT } from "../extensions/lib/bootstrap-prompt.ts";
import { loadConfig } from "../extensions/lib/config.ts";
import { type RunFn, run } from "../extensions/lib/process.ts";

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
	"docs/adr/0008-scripts-live-outside-the-omp-tool-directories.md",
	"docs/adr/0009-recoverable-omp-supervision.md",
	"docs/adr/0010-native-backend-workers.md",
	"docs/adr/0011-the-ste100-skill-is-the-only-checker.md",
	"docs/plans/recoverable-omp-supervision.md",
];

/** The steps that install the skill on a machine that does not hold it. */
const INSTALL_STEPS = [
	"The ste100 skill is not built on this machine.",
	"Install it and build it:",
	"  git clone <the ste100 skill> ~/.claude/skills/ste100",
	"  cd ~/.claude/skills/ste100 && npm install && npm run build",
	"Then run the command again.",
];

/**
 * The command that scores every document.
 *
 * The command starts the checker of the skill with node. It gives the skill
 * the word list of this repository, every document and the reporting
 * contract. The exit code of the checker is the exit code of the command.
 */
export async function main(exec: RunFn, skill: string, root: string): Promise<number> {
	const cli = join(skill, "dist", "cli.js");
	if (!existsSync(cli)) {
		for (const line of INSTALL_STEPS) console.log(line);
		return 2;
	}
	const contract = join(tmpdir(), `wt-ste100-contract-${process.pid}.md`);
	const dictionary = join(root, "resources", "ste100-dictionary.json");
	try {
		writeFileSync(contract, REPORTING_CONTRACT, "utf8");
		const args = [cli, "--dictionary", dictionary, ...CHECKED_DOCUMENTS, contract];
		const result = await exec("node", args, root);
		if (result.stdout) console.log(result.stdout.trimEnd());
		if (result.stderr) console.log(result.stderr.trimEnd());
		return result.code;
	} finally {
		rmSync(contract, { force: true });
	}
}

// Run only when this file is the entry point. A test imports the command.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
	const config = loadConfig();
	process.exit(await main(run, config.ste100Skill, process.cwd()));
}

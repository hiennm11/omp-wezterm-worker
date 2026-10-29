import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../extensions/lib/config.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { REPORTING_CONTRACT } from "../extensions/lib/bootstrap-prompt.ts";
import { CHECKED_DOCUMENTS, main } from "../tooling/ste100-docs.ts";

const ROOT = join(import.meta.dirname, "..");

function configFile(content: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-ste-config-"));
	const file = join(dir, "wezterm-worker.json");
	writeFileSync(file, JSON.stringify(content), "utf8");
	return file;
}

test("the skill folder defaults to the ste100 skill of the user", () => {
	assert.equal(DEFAULT_CONFIG.ste100Skill, join(homedir(), ".claude", "skills", "ste100"));
	const cfg = loadConfig(join(tmpdir(), `no-such-config-${Date.now()}.json`), {});
	assert.equal(cfg.ste100Skill, DEFAULT_CONFIG.ste100Skill);
});

test("the config file sets the skill folder and a home path expands", () => {
	const plain = loadConfig(configFile({ ste100Skill: "/opt/ste100" }), {});
	assert.equal(plain.ste100Skill, "/opt/ste100");
	const home = loadConfig(configFile({ ste100Skill: "~/skills/ste100" }), {});
	assert.equal(home.ste100Skill, join(homedir(), "skills", "ste100"));
	const wrong = loadConfig(configFile({ ste100Skill: 42 }), {});
	assert.equal(wrong.ste100Skill, DEFAULT_CONFIG.ste100Skill);
});

/** A skill folder that holds the command, or an empty folder. */
function skillFolder(built: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-ste-skill-"));
	if (built) {
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "cli.js"), "", "utf8");
	}
	return dir;
}

function fakeExec(code: number): {
	exec: RunFn;
	calls: { bin: string; args: string[]; cwd?: string; contract: boolean }[];
} {
	const calls: { bin: string; args: string[]; cwd?: string; contract: boolean }[] = [];
	const exec: RunFn = async (bin, args, cwd): Promise<RunResult> => {
		const extra = args.filter((arg) => arg.endsWith(".md") && !CHECKED_DOCUMENTS.includes(arg));
		const contract = extra.some((file) => existsSync(file) && readFileSync(file, "utf8") === REPORTING_CONTRACT);
		calls.push({ bin, args, cwd, contract });
		return { code, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

test("the document check gives every document and the reporting contract to the skill checker and returns its exit code", async () => {
	const skill = skillFolder(true);
	for (const code of [0, 1]) {
		const { exec, calls } = fakeExec(code);
		assert.equal(await main(exec, skill, ROOT), code);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].bin, "node");
		assert.equal(calls[0].args[0], join(skill, "dist", "cli.js"));
		assert.equal(calls[0].cwd, ROOT);
		assert.equal(calls[0].contract, true, "the reporting contract goes to the same call");
		for (const document of CHECKED_DOCUMENTS) assert.ok(calls[0].args.includes(document), document);
		const dictionary = calls[0].args[calls[0].args.indexOf("--dictionary") + 1];
		assert.ok(dictionary?.endsWith("ste100-dictionary.json"));
	}
});

test("the document check fails with exit code 2 when the skill is not built", async () => {
	const { exec, calls } = fakeExec(0);
	assert.equal(await main(exec, skillFolder(false), ROOT), 2);
	assert.equal(calls.length, 0);
});

test("the list of documents holds existing files and leaves out the evidence of a run", () => {
	assert.ok(CHECKED_DOCUMENTS.length >= 15);
	for (const document of CHECKED_DOCUMENTS) assert.ok(existsSync(join(ROOT, document)), document);
	assert.ok(!CHECKED_DOCUMENTS.includes("docs/trials/windows-trial.md"));
	assert.ok(!CHECKED_DOCUMENTS.includes("docs/backend-proof-evidence.md"));
	assert.ok(CHECKED_DOCUMENTS.includes("AGENTS.md"));
});

test("the word list of the repository keeps the terms of the glossary and the other words", () => {
	const words = JSON.parse(readFileSync(join(ROOT, "resources", "ste100-dictionary.json"), "utf8")) as Record<
		string,
		string
	>;
	assert.ok(Object.keys(words).length > 2000);
	for (const term of ["event", "events", "resume", "resumed", "attempt", "deliver", "delivered", "restored"]) {
		assert.equal(term in words, false, term);
	}
	assert.equal(words.utilize, "use");
	assert.equal(words.therefore, "thus");
});

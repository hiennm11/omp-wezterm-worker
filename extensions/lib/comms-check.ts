/**
 * The communication check for the text that the main session and the workers exchange.
 *
 * The check scores a text with the checker of the ste100 skill. That skill is
 * the only checker of this repository. A low score means that a reader can
 * read the text in more than one way. The check never throws, so a broken
 * text cannot stop a tool. A text is never refused when the checker does not
 * run.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunFn, RunResult } from "./process.ts";

/** The channel that carries the text. */
export type CommsChannel = "task" | "steer" | "result";

/** The mode of the check. */
export type CommsMode = "off" | "warn" | "enforce";

/** The settings of the check. */
export interface CommsSettings {
	mode: CommsMode;
	minScore: number;
}

/**
 * The verdict of the check.
 *
 * The verdict `fail` marks a text that the enforce mode refuses. The warn
 * mode never produces it, because the warn mode lets the text through.
 */
export type CommsVerdict = "pass" | "warn" | "fail" | "skipped" | "off";

/** One problem that the checker found in a text. */
export interface Finding {
	/** The name of the rule that the text breaks. */
	rule: string;
	/** The text of the finding. */
	message: string;
	/** The line of the text that the finding names. */
	line: number;
}

/** The outcome of the check. */
export interface CommsResult {
	/** The score of the text, from 0 to 100. */
	score: number;
	/** The first findings of the text. */
	findings: Finding[];
	/** The verdict of the check. */
	verdict: CommsVerdict;
	/** The channel that carried the text. */
	channel: CommsChannel;
	/** The reason that the checker did not run. */
	note?: string;
}

/** The number of findings that a report holds. */
const MAX_FINDINGS = 5;

/** The number of words that a text must have to be checked. */
const MIN_WORDS = 3;

/** The word list of this repository. The checker reads it for every text. */
const DICTIONARY = join(import.meta.dirname, "..", "..", "resources", "ste100-dictionary.json");

/** The letters that a Vietnamese text carries. */
const VIETNAMESE_LETTERS = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũừứựửữỳýỵỷỹđ";

/** The letters that carry a Vietnamese diacritic. */
const VIETNAMESE_LETTER = new RegExp(`[${VIETNAMESE_LETTERS}]`, "giu");

/** Every letter of a text. */
const LETTER = /\p{L}/gu;

/** The share of the letters that must carry a Vietnamese diacritic to skip a text. */
const VIETNAMESE_SHARE = 0.05;

/** The number of words in a text. */
function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * The share of the letters of a text that carry a Vietnamese diacritic.
 *
 * A name in an English text carries few diacritics. A Vietnamese sentence
 * carries many. The share tells the two apart.
 */
function vietnameseShare(text: string): number {
	const letters = text.match(LETTER);
	if (!letters || letters.length === 0) return 0;
	const accented = text.match(VIETNAMESE_LETTER);
	return (accented ? accented.length : 0) / letters.length;
}

/** The report that the checker of the skill prints. */
interface SkillReport {
	documents?: Array<{
		score?: number;
		findings?: Array<{ rule?: string; message?: string; line?: number }>;
	}>;
}

/** The note that names the skill and its folder when the checker does not run. */
function missingCheckerNote(skill: string): string {
	return `The ste100 skill checker did not run. The skill folder is ${skill}.`;
}

/** The result of a text that no checker scored. */
function skippedResult(channel: CommsChannel, note?: string): CommsResult {
	const result: CommsResult = { score: 100, findings: [], verdict: "skipped", channel };
	if (note !== undefined) result.note = note;
	return result;
}

/**
 * The score of a text, its first findings and its verdict.
 *
 * A text that is mostly Vietnamese is skipped. The checker cannot score a
 * text that the reader does not read in English. A name in an English text
 * does not make the text Vietnamese. A text that is too short carries no
 * sentence to check. The off mode does not score the text at all, so it
 * reports a score of 100 and no findings.
 *
 * The checker of the skill runs in a child process. The text goes into a
 * file of a temporary directory, and the directory is removed after the
 * check. A checker that does not run gives the verdict skipped, also in the
 * enforce mode.
 */
export async function checkComms(
	exec: RunFn,
	skill: string,
	text: string,
	channel: CommsChannel,
	settings: CommsSettings,
): Promise<CommsResult> {
	if (settings.mode === "off") {
		return { score: 100, findings: [], verdict: "off", channel };
	}
	const body = typeof text === "string" ? text : "";
	if (vietnameseShare(body) > VIETNAMESE_SHARE || countWords(body) < MIN_WORDS) {
		return skippedResult(channel);
	}
	const dir = mkdtempSync(join(tmpdir(), "wt-comms-"));
	const file = join(dir, "text.md");
	try {
		writeFileSync(file, body, "utf8");
		const args = [join(skill, "dist", "cli.js"), "--json", "--dictionary", DICTIONARY, file];
		let run: RunResult;
		try {
			run = await exec("node", args);
		} catch {
			// A checker that fails must not stop a tool. The text stays unchecked.
			return skippedResult(channel, missingCheckerNote(skill));
		}
		if (run.code !== 0 && run.code !== 1) {
			return skippedResult(channel, missingCheckerNote(skill));
		}
		const report = parseReport(run.stdout);
		if (!report) return skippedResult(channel, missingCheckerNote(skill));
		const document = report.documents?.[0];
		const score = document?.score;
		if (typeof score !== "number") {
			return skippedResult(channel, missingCheckerNote(skill));
		}
		const findings = (document?.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({
			rule: finding.rule ?? "",
			message: finding.message ?? "",
			line: finding.line ?? 0,
		}));
		const below = score < settings.minScore;
		const verdict: CommsVerdict = below ? (settings.mode === "enforce" ? "fail" : "warn") : "pass";
		return { score, findings, verdict, channel };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The report of the checker, or null when the output is not a report. */
function parseReport(stdout: string): SkillReport | null {
	try {
		const parsed = JSON.parse(stdout) as SkillReport;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

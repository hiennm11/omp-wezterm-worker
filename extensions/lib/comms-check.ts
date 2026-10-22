/**
 * The communication check for the text that the main session and the workers exchange.
 *
 * The check scores a text with the Simplified Technical English checker. A low
 * score means that a reader can read the text in more than one way. The check
 * never reads a file and never throws, so a broken text cannot stop a tool.
 */

import { checkDocument, type Finding, type Report } from "./ste100.ts";

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
}

/** The number of findings that a report holds. */
const MAX_FINDINGS = 5;

/** The number of words that a text must have to be checked. */
const MIN_WORDS = 3;

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

/**
 * The score of a text, its first findings and its verdict.
 *
 * A text that is mostly Vietnamese is skipped. The check cannot score a text
 * that the reader does not read in English. A name in an English text does not
 * make the text Vietnamese. A text that is too short carries no sentence to
 * check. The off mode does not score the text at all, so it reports a score
 * of 100 and no findings.
 */
export function checkComms(text: string, channel: CommsChannel, settings: CommsSettings): CommsResult {
	if (settings.mode === "off") {
		return { score: 100, findings: [], verdict: "off", channel };
	}
	const body = typeof text === "string" ? text : "";
	if (vietnameseShare(body) > VIETNAMESE_SHARE || countWords(body) < MIN_WORDS) {
		return { score: 100, findings: [], verdict: "skipped", channel };
	}
	let report: Report;
	try {
		report = checkDocument(body);
	} catch {
		// A checker that fails must not stop a tool. The text stays unchecked.
		return { score: 100, findings: [], verdict: "skipped", channel };
	}
	const below = report.score < settings.minScore;
	const verdict: CommsVerdict = below ? (settings.mode === "enforce" ? "fail" : "warn") : "pass";
	return {
		score: report.score,
		findings: report.findings.slice(0, MAX_FINDINGS),
		verdict,
		channel,
	};
}

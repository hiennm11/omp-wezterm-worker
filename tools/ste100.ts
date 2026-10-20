/**
 * A checker for Simplified Technical English.
 *
 * The standard is a controlled language: a maintenance manual read at 3 a.m.
 * by a second-language speaker must have exactly one possible reading. This
 * checker enforces the rules that a machine can enforce, so a document can
 * carry a measured score instead of a claim.
 *
 * The score is the share of sentences that break no rule. A sentence that
 * breaks a rule is not counted as a pass.
 */

/** The maximum words in a sentence, by the kind of text it belongs to. */
export const SENTENCE_LIMIT_DESCRIPTIVE = 25;
export const SENTENCE_LIMIT_PROCEDURAL = 20;

/** Words that a simpler word replaces. */
const REPLACEMENTS: Record<string, string> = {
	ensure: "make sure",
	"prior to": "before",
	replenish: "fill",
	utilise: "use",
	utilize: "use",
	utilizes: "uses",
	utilized: "used",
	commence: "start",
	commences: "starts",
	commenced: "started",
	approximately: "about",
	"in order to": "to",
	terminate: "stop",
	terminates: "stops",
	terminated: "stopped",
	modify: "change",
	modifies: "changes",
	modified: "changed",
	obtain: "get",
	obtains: "gets",
	obtained: "got",
	"subsequent to": "after",
	"close to": "near",
	"a number of": "some",
	numerous: "many",
	sufficient: "enough",
	endeavour: "try",
	endeavor: "try",
};

/** Soft phrasal verbs and the plain verb that replaces them. */
const PHRASAL_VERBS: Record<string, string> = {
	"spin up": "start",
	"spun up": "started",
	"reach out": "contact",
	"dive into": "read",
	"kick off": "start",
	"circle back": "return",
	"touch base": "communicate",
};

/** Filler words that carry no meaning. */
const FILLER = [
	"simply",
	"just",
	"basically",
	"actually",
	"of course",
	"obviously",
	"very",
	"quite",
	"rather",
	"delve",
	"leverage",
	"tapestry",
	"seamless",
	"seamlessly",
	"revolutionize",
	"testament",
	"beacon",
	"game-changer",
	"holistic",
	"blazing-fast",
	"state-of-the-art",
];

/** Modal verbs that STE replaces with a firm one. */
const VAGUE_MODALS = ["should", "ought to", "shall"];

export type RuleId =
	| "SENTENCE_TOO_LONG"
	| "SEMICOLON"
	| "UNAPPROVED_WORD"
	| "PHRASAL_VERB"
	| "NOMINALIZATION"
	| "FILLER_WORD"
	| "PROGRESSIVE_TENSE"
	| "PERFECT_TENSE"
	| "VAGUE_MODAL"
	| "PARAGRAPH_TOO_LONG"
	| "NOUN_CLUSTER";

export interface Finding {
	rule: RuleId;
	message: string;
	sentence: string;
	line: number;
}

export interface Report {
	/** The share of sentences that break no rule, from 0 to 100. */
	score: number;
	totalSentences: number;
	passingSentences: number;
	findings: Finding[];
}

export interface CheckOptions {
	/** The word limit for a sentence. Defaults to the descriptive limit. */
	sentenceLimit?: number;
}

/**
 * Remove the parts of a document that the rules do not apply to.
 *
 * Code, inline code, quotes, and link targets stay as they are: the reader
 * matches the text to their own file, so a rule that changes them breaks the
 * document.
 */
function stripExempt(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
		.replace(/^ {0,3}>.*$/gm, (m) => " ".repeat(m.length))
		.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, (m) => " ".repeat(m.length))
		.replace(/^\s*\|.*\|\s*$/gm, (m) => " ".repeat(m.length))
		.replace(/^\s*[-*+]\s/gm, (m) => m.replace(/[^\n]/g, " "))
		.replace(/^\s*\d+\.\s/gm, (m) => m.replace(/[^\n]/g, " "))
		.replace(/^\s*#{1,6}\s.*$/gm, (m) => m.replace(/[^\n]/g, " "));
}

/** Split a document into sentences, and keep the line each one starts on. */
function splitSentences(text: string): Array<{ text: string; line: number }> {
	const lines = text.split("\n");
	const sentences: Array<{ text: string; line: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const parts = line.split(/(?<=[.!?])\s+/);
		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed) continue;
			if (!/[a-zA-Z]/.test(trimmed)) continue;
			sentences.push({ text: trimmed, line: i + 1 });
		}
	}
	return sentences;
}

/** Count the words in a sentence. */
function countWords(sentence: string): number {
	const withoutCode = sentence.replace(/`[^`]*`/g, " code ");
	return withoutCode.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;
}

/** Suffixes that mark a word as a noun. */
const NOUN_SUFFIXES = ["tion", "sion", "ment", "ness", "ity", "ance", "ence", "ship", "ism"];

/**
 * Find the noun clusters in a sentence.
 *
 * A cluster is three words in a row that all name things. Without a part of
 * speech tagger the test uses noun suffixes, so only clear cases count. A
 * check that flags every sentence is not a check.
 */
function findNounClusters(sentence: string): string[] {
	const words = sentence.replace(/[`*_]/g, "").split(/\s+/);
	const clusters: string[] = [];
	let run: string[] = [];
	let nounsInRun = 0;
	const flush = () => {
		if (run.length >= 3 && nounsInRun >= 2) clusters.push(run.join(" "));
		run = [];
		nounsInRun = 0;
	};
	for (const word of words) {
		const clean = word.replace(/[^\w-]/g, "");
		if (!clean) continue;
		if (/^(of|in|for|with|from|to|by|on|at|into|after|before|that|which|the|a|an)$/i.test(clean)) {
			flush();
			continue;
		}
		const isNoun = NOUN_SUFFIXES.some((suffix) => clean.toLowerCase().endsWith(suffix));
		run.push(clean);
		if (isNoun) nounsInRun++;
	}
	flush();
	return clusters;
}

/**
 * Check a document.
 *
 * The score is the share of sentences that break no rule. It is not a claim
 * of full compliance with the standard: the standard also has rules that a
 * machine cannot check, such as one word for one meaning across a document.
 */
export function checkDocument(markdown: string, options: CheckOptions = {}): Report {
	const limit = options.sentenceLimit ?? SENTENCE_LIMIT_DESCRIPTIVE;
	const stripped = stripExempt(markdown);
	const sentences = splitSentences(stripped);
	const findings: Finding[] = [];
	const failing = new Set<number>();

	const add = (index: number, rule: RuleId, message: string) => {
		findings.push({ rule, message, sentence: sentences[index].text, line: sentences[index].line });
		failing.add(index);
	};

	sentences.forEach((sentence, index) => {
		const lower = sentence.text.toLowerCase();

		if (sentence.text.includes(";")) {
			add(index, "SEMICOLON", "Split this sentence at the semicolon.");
		}

		const words = countWords(sentence.text);
		if (words > limit) {
			add(index, "SENTENCE_TOO_LONG", `This sentence has ${words} words. The limit is ${limit}.`);
		}

		for (const [word, replacement] of Object.entries(REPLACEMENTS)) {
			if (new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`).test(lower)) {
				add(index, "UNAPPROVED_WORD", `Use "${replacement}" instead of "${word}".`);
			}
		}

		for (const [phrase, replacement] of Object.entries(PHRASAL_VERBS)) {
			if (new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`).test(lower)) {
				add(index, "PHRASAL_VERB", `Use the plain verb "${replacement}" instead of "${phrase}".`);
			}
		}

		const nominal =
			/\b(perform|conduct|carry out|carries out|performed|conducted)\s+(?:a|an|the)\s+\w+(?:tion|sion|ment|ance|ence|ysis)\b/.exec(
				lower,
			);
		if (nominal) {
			add(index, "NOMINALIZATION", `Use a direct verb instead of "${nominal[0]}".`);
		}

		for (const word of FILLER) {
			if (new RegExp(`\\b${word.replace(/[-]/g, "\\-")}\\b`).test(lower)) {
				add(index, "FILLER_WORD", `Delete the word "${word}".`);
			}
		}

		const progressive = /\b(?:is|are|was|were|been)\s+(\w+ing)\b/.exec(lower);
		if (progressive) {
			add(index, "PROGRESSIVE_TENSE", `Use a simple tense instead of "${progressive[0]}".`);
		}

		const perfect = /\b(?:has|have|had)\s+(been\s+)?(\w+(?:ed|en))\b/.exec(lower);
		if (perfect) {
			add(index, "PERFECT_TENSE", `Use a simple past instead of "${perfect[0]}".`);
		}

		for (const modal of VAGUE_MODALS) {
			if (new RegExp(`\\b${modal.replace(/ /g, "\\s+")}\\b`).test(lower)) {
				add(index, "VAGUE_MODAL", `Use "must" or "can" instead of "${modal}".`);
			}
		}

		const clusters = findNounClusters(sentence.text);
		for (const cluster of clusters) {
			add(index, "NOUN_CLUSTER", `Break the noun cluster "${cluster}".`);
		}
	});

	const totalSentences = sentences.length;
	const passingSentences = totalSentences - failing.size;
	const score = totalSentences === 0 ? 100 : Math.round((passingSentences / totalSentences) * 100);

	return { score, totalSentences, passingSentences, findings };
}

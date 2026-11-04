/**
 * The thinking level of a worker.
 *
 * OMP has the flag `--thinking <level>`. The extension asks for the level
 * that the user chose. OMP maps a level that the model lacks, so the
 * extension never maps a level to another level.
 */

/** The thinking levels that OMP accepts. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

/** The thinking levels that OMP accepts. */
export const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"auto",
];

/** True when the value names a thinking level of OMP. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as string[]).includes(value);
}

/**
 * The thinking level of a value, or null when the value names none.
 *
 * A missing value and a wrong value give null. Null means that the worker
 * runs at the default level of OMP.
 */
export function readThinkingLevel(value: unknown): ThinkingLevel | null {
	return isThinkingLevel(value) ? value : null;
}

/** The text that refuses a value that names no thinking level. */
export function thinkingRefusal(value: unknown): string {
	return `Unknown thinking level '${String(value)}'. ` + `Use one of: ${THINKING_LEVELS.join(", ")}.`;
}

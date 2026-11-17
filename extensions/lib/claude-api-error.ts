/**
 * The API error of a Claude Code worker.
 *
 * A Claude Code worker that hits the usage limit of its account writes one
 * row in the transcript of its session. The row names the error, the status
 * of the API and the time of the reset. The hook of the mod does not carry
 * the kind of the error, so the tail of the transcript is the source.
 *
 * The parser is a pure function of the text of the tail. A test can check
 * it without a file.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** The error of one API call of a Claude session. */
export interface ClaudeApiError {
	/** The kind of the error, for example `rate_limit`. */
	error: string;
	/** The status of the API, for example 429. */
	apiErrorStatus: number | null;
	/** The time of the reset in epoch milliseconds, or null when the row holds none. */
	resetsAt: number | null;
	/** The kind of the limit, for example `five_hour`, or null. */
	rateLimitType: string | null;
}

/** The number of bytes that the reader takes from the end of the file. */
export const TAIL_BYTES = 256 * 1024;

/** The kind of the error that means the account reached its limit. */
export const RATE_LIMIT_ERROR = "rate_limit";

/**
 * The last error row of the text of a tail, or null when the text holds none.
 *
 * The function reads the lines from the end. A line that is not JSON holds no
 * error, so the function skips it. The reader drops the cut first line of a
 * tail before it calls this function.
 */
export function parseLastApiError(tail: string): ClaudeApiError | null {
	const lines = tail.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const error = parseErrorRow(lines[index]);
		if (error) return error;
	}
	return null;
}

/**
 * The error of one row of a transcript, or null when the row holds none.
 *
 * The row names the error in the field `error`. The row of a rate limit
 * holds the time of the reset in the field `quotaLimits.resetsAt`. That
 * value is an epoch in seconds, and this module converts it to
 * milliseconds.
 */
function parseErrorRow(line: string): ClaudeApiError | null {
	const text = line.trim();
	if (!text.startsWith("{")) return null;
	let row: unknown;
	try {
		row = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof row !== "object" || row === null) return null;
	const record = row as Record<string, unknown>;
	if (typeof record.error !== "string" || record.error.length === 0) return null;
	const status = record.apiErrorStatus;
	const quota = record.quotaLimits;
	const quotaRecord = typeof quota === "object" && quota !== null ? (quota as Record<string, unknown>) : null;
	const resetsAt = quotaRecord?.resetsAt;
	const rateLimitType = quotaRecord?.rateLimitType;
	return {
		error: record.error,
		apiErrorStatus: typeof status === "number" ? status : null,
		resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
		rateLimitType: typeof rateLimitType === "string" && rateLimitType.length > 0 ? rateLimitType : null,
	};
}

/**
 * The directory of the sessions of Claude Code, below the home of the user.
 *
 * The owner reads a file of that directory only. The path comes from a
 * token bound bridge, and the owner must still read no other file.
 */
export function claudeProjectsDir(home: string = homedir()): string {
	return join(home, ".claude", "projects");
}

/**
 * True when the path names a file of the sessions of Claude Code.
 *
 * The function resolves the path first. A path that leaves the directory
 * after the resolution is refused.
 */
export function isInsideClaudeProjects(path: string, home: string = homedir()): boolean {
	if (path.includes("..")) return false;
	const root = resolve(claudeProjectsDir(home));
	const target = resolve(path);
	if (target === root) return false;
	return target.startsWith(`${root}${sep}`);
}

/**
 * The last error row of the transcript of a session, or null.
 *
 * The function reads the tail of the file. It never reads the whole file,
 * because a long session holds more bytes than the host allows. The first
 * line of a partial tail is a cut line, so the function drops it.
 */
export function readLastApiError(path: string, home: string = homedir()): ClaudeApiError | null {
	if (!isInsideClaudeProjects(path, home)) return null;
	const size = statSync(path).size;
	const length = Math.min(size, TAIL_BYTES);
	const buffer = Buffer.alloc(length);
	const handle = openSync(path, "r");
	try {
		readSync(handle, buffer, 0, length, size - length);
	} finally {
		closeSync(handle);
	}
	const text = buffer.toString("utf8");
	/* The first line of a partial tail is a cut line. It holds no row. */
	const tail = size > length ? text.slice(text.indexOf("\n") + 1) : text;
	return parseLastApiError(tail);
}

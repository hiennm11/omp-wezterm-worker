/**
 * The API error of a Claude Code worker.
 *
 * A Claude Code worker that hits the usage limit of its account writes one
 * row in the transcript of its session. The row names the error and the
 * time of the reset. The parser reads that row from the tail of the file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseLastApiError, readLastApiError } from "../extensions/lib/claude-api-error.ts";

/** The row of an assistant message that failed with a rate limit. */
const RATE_LIMIT_ROW = JSON.stringify({
	type: "assistant",
	error: "rate_limit",
	isApiErrorMessage: true,
	apiErrorStatus: 429,
	quotaLimits: {
		status: "rejected",
		resetsAt: 1792135800,
		rateLimitType: "five_hour",
	},
});

test("the last error row of the tail gives the error and its status", () => {
	const error = parseLastApiError(`${RATE_LIMIT_ROW}\n`);
	assert.ok(error, "the tail holds an error row");
	assert.equal(error.error, "rate_limit");
	assert.equal(error.apiErrorStatus, 429);
	assert.equal(error.rateLimitType, "five_hour");
});

test("the reset time of the row is in milliseconds", () => {
	const error = parseLastApiError(`${RATE_LIMIT_ROW}\n`);
	assert.equal(error?.resetsAt, 1792135800000);
});

test("a row without quota limits gives no reset time", () => {
	const row = JSON.stringify({
		type: "assistant",
		error: "rate_limit",
		isApiErrorMessage: true,
		apiErrorStatus: 429,
		quotaLimits: null,
	});
	const error = parseLastApiError(`${row}\n`);
	assert.ok(error, "the tail holds an error row");
	assert.equal(error.error, "rate_limit");
	assert.equal(error.apiErrorStatus, 429);
	assert.equal(error.resetsAt, null);
	assert.equal(error.rateLimitType, null);
});

test("a cut first line does not hide the last error row", () => {
	const tail = `"usage":{"input_tokens":3}}}}\n${RATE_LIMIT_ROW}\n`;
	const error = parseLastApiError(tail);
	assert.equal(error?.error, "rate_limit");
});

test("an empty file gives no error row", () => {
	assert.equal(parseLastApiError(""), null);
});

test("a file without an error row gives no error row", () => {
	const row = JSON.stringify({ type: "assistant", message: { content: [] } });
	assert.equal(parseLastApiError(`${row}\n`), null);
});

test("the last error row wins over an earlier one", () => {
	const earlier = JSON.stringify({ type: "assistant", error: "invalid_request", apiErrorStatus: 400 });
	const error = parseLastApiError(`${earlier}\n${RATE_LIMIT_ROW}\n`);
	assert.equal(error?.error, "rate_limit");
});

test("the reader finds the error row at the end of the file", () => {
	const home = mkdtempSync(join(tmpdir(), "wz-home-"));
	const projects = join(home, ".claude", "projects", "C--repo");
	mkdirSync(projects, { recursive: true });
	const file = join(projects, "session-1.jsonl");
	writeFileSync(file, `${RATE_LIMIT_ROW}\n`);
	try {
		const error = readLastApiError(file, home);
		assert.equal(error?.error, "rate_limit");
		assert.equal(error?.resetsAt, 1792135800000);
		assert.equal(error?.rateLimitType, "five_hour");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the reader finds the error row at the end of a large file", () => {
	const home = mkdtempSync(join(tmpdir(), "wz-home-"));
	const projects = join(home, ".claude", "projects", "C--repo");
	mkdirSync(projects, { recursive: true });
	const file = join(projects, "session-1.jsonl");
	const filler = `${JSON.stringify({ type: "assistant", text: "x".repeat(1000) })}\n`;
	let body = "";
	while (body.length < 5 * 1024 * 1024) body += filler;
	writeFileSync(file, `${body}${RATE_LIMIT_ROW}\n`);
	try {
		assert.ok(statSync(file).size > 4_194_304, "the file is larger than the host allows");
		const error = readLastApiError(file, home);
		assert.equal(error?.error, "rate_limit");
		assert.equal(error?.resetsAt, 1792135800000);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the reader refuses a path outside the projects of Claude Code", () => {
	const home = mkdtempSync(join(tmpdir(), "wz-home-"));
	const outside = join(home, "secret.jsonl");
	writeFileSync(outside, `${RATE_LIMIT_ROW}\n`);
	try {
		assert.equal(readLastApiError(outside, home), null);
		assert.equal(readLastApiError(join(home, ".claude", "projects", "..", "..", "secret.jsonl"), home), null);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

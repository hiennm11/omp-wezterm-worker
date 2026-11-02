/**
 * The usage of a Codex worker and the text of the status tool.
 *
 * The usage of a Codex turn comes from the messages of the app server of
 * Codex. The extension sums the measured counts and shows them in the
 * status tool. A count that Codex does not report stays missing, and the
 * extension never writes a zero for it.
 *
 * The tests read the text of the real status tool. They use the real
 * messages of the proof, so no test writes a message from memory.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { type CodexRun, codexRun, messageOf, messagesOf, statusText } from "./codex-events-helpers.ts";

/** The usage of the first turn of the fixture. */
const FIRST_INPUT = 59495;
const FIRST_OUTPUT = 173;
const FIRST_CACHE_READ = 58368;

/** The usage of the thread after the second turn of the fixture. */
const SECOND_INPUT = 105067;
const SECOND_OUTPUT = 281;
const SECOND_CACHE_READ = 103168;

/**
 * Send the first turn of the fixture with its usage.
 *
 * The messages of the app server carry the totals of the thread. The
 * extension measures the change of the totals for the turn.
 */
function sendFirstTurnWithUsage(run: CodexRun): void {
	run.send(messageOf("turnStarted1"));
	run.sendAll(messagesOf("tokenUsageTurn1"));
	run.send(messageOf("turnCompleted1"));
}

/**
 * Send the second turn of the fixture with its usage.
 *
 * The totals of the thread grow. The usage of the second turn is the
 * change between the totals of the thread.
 */
function sendSecondTurnWithUsage(run: CodexRun): void {
	run.send(messageOf("turnStarted2"));
	run.sendAll(messagesOf("tokenUsageTurn2"));
	run.send(messageOf("turnCompleted2"));
}

test("a message of the app server changes the usage that the status tool shows", async () => {
	const without = await codexRun();
	let text = "";
	try {
		/* A turn that ends without a usage message holds no measured
		   count, so the status knows nothing about the usage. */
		without.send(messageOf("turnStarted1"));
		without.send(messageOf("turnCompleted1"));
		text = await statusText(without.rt);
		assert.match(text, /tokens\s+: unknown/, text);
	} finally {
		await without.close();
	}

	const withUsage = await codexRun();
	try {
		sendFirstTurnWithUsage(withUsage);
		text = await statusText(withUsage.rt);
		assert.match(text, /tokens\s+: \d+ tokens, measured/, text);
		assert.match(text, new RegExp(`input ${FIRST_INPUT}`), text);
		assert.match(text, new RegExp(`output ${FIRST_OUTPUT}`), text);
		assert.match(text, new RegExp(`cache read ${FIRST_CACHE_READ}`), text);
	} finally {
		await withUsage.close();
	}
});

test("a count that the message of Codex does not report stays missing in the text", async () => {
	const run = await codexRun();
	try {
		sendFirstTurnWithUsage(run);
		const text = await statusText(run.rt);

		/* The message of the app server holds no price of the tokens, so
		   the text says that the cost is unknown. The text never shows a
		   zero for it. */
		assert.match(text, /cost unknown/, text);
		assert.doesNotMatch(text, /cost 0\b/, text);
	} finally {
		await run.close();
	}
});

test("the usage of two turns is the sum of the changes of the totals", async () => {
	const run = await codexRun();
	try {
		sendFirstTurnWithUsage(run);
		sendSecondTurnWithUsage(run);

		const text = await statusText(run.rt);

		/* The first turn measured the totals of the thread. The second
		   turn measured the change of the totals. Their sum is the last
		   total of the thread. */
		assert.match(text, new RegExp(`input ${SECOND_INPUT}`), text);
		assert.match(text, new RegExp(`output ${SECOND_OUTPUT}`), text);
		assert.match(text, new RegExp(`cache read ${SECOND_CACHE_READ}`), text);
		assert.match(text, /tokens\s+: \d+ tokens, measured/, text);

		/* The sum of the two turns holds the same counts as the text. */
		const totals = run.state.usage;
		assert.equal(totals.turns.input, FIRST_INPUT + (SECOND_INPUT - FIRST_INPUT));
		assert.equal(totals.turns.output, FIRST_OUTPUT + (SECOND_OUTPUT - FIRST_OUTPUT));
		assert.equal(totals.turns.cacheRead, FIRST_CACHE_READ + (SECOND_CACHE_READ - FIRST_CACHE_READ));
	} finally {
		await run.close();
	}
});

test("a worker that ends keeps its usage and a later session shows the same counts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-usage-"));
	const run = await codexRun({ stateDir: dir });
	let later: WorkerRuntime | null = null;
	try {
		sendFirstTurnWithUsage(run);
		await finalizeJob(run.rt, run.job, "completed", null, "THE-ANSWER");
		run.rt.persist();

		/* The run state is gone. The job holds the copy of the usage. */
		assert.equal(run.rt.claudeStates.has(run.job.id), false, "the run state stayed in the runtime");
		assert.ok(run.job.nativeUsage, "the job holds no usage of the run");
		assert.equal(run.job.nativeUsage.turns.input, FIRST_INPUT);

		/* A later session reads the run from the registry and shows the
		   same counts. */
		later = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
		later.config.stateDir = dir;
		const { finished } = later.readRegistry();
		const job = finished.find((row) => row.id === run.job.id);
		assert.ok(job, "the later session reads no worker");
		later.jobs.set(job.id, job);

		const text = await statusText(later);
		assert.match(text, new RegExp(`input ${FIRST_INPUT}`), text);
		assert.match(text, new RegExp(`output ${FIRST_OUTPUT}`), text);
		assert.match(text, /tokens\s+: \d+ tokens, measured/, text);
	} finally {
		await run.close();
		if (later) later.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a worker with a turn that carries no usage shows a partial usage and not a zero", async () => {
	const run = await codexRun();
	try {
		/* The first turn carries its usage. The second turn carries
		   none, because the app server sent no usage message for it. */
		sendFirstTurnWithUsage(run);
		run.send(messageOf("turnStarted2"));
		run.send(messageOf("turnCompleted2"));

		const text = await statusText(run.rt);

		assert.match(text, /tokens\s+: \d+ tokens, partial/, text);
		assert.match(text, /1 of 2 model calls have no usage data/, text);
		/* The turn without a usage adds no count. The text shows the
		   counts of the measured turn and no zero for the other one. */
		assert.match(text, new RegExp(`input ${FIRST_INPUT}`), text);
		assert.equal(run.state.usage.calls, 1, "the run holds more than one measured call");
		assert.equal(run.state.usage.callsWithoutUsage, 1, "the run lost the call without usage");
	} finally {
		await run.close();
	}
});

/**
 * The tools that act on a worker which is still running.
 *
 * `wezterm_worker_steer`, `wezterm_worker_peek` and `wezterm_worker_cancel`
 * all need a live pane. The tests start a worker with a long task, so the
 * worker is still running when the test acts on it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readReports } from "../extensions/lib/report-store.ts";
import {
	answerAfterLastUser,
	createHost,
	currentPanes,
	detailBoolean,
	detailNumber,
	detailString,
	readTranscript,
	removeDir,
	sessionContext,
	waitFor,
} from "./harness.ts";

function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN = hasProgram("omp") && hasProgram("wezterm");

/** A task that keeps the worker busy for a while. */
const LONG_TASK =
	"Count from 1 to 200 slowly. Write one number per line into a file named count.txt " +
	"in the current working directory, using the write tool, one number at a time. " +
	"Then reply with the word DONE.";

test("a running worker can be steered, peeked at and cancelled", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-live-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-live-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: LONG_TASK,
			cwd: repo,
			label: "live",
		});
		const workerId = detailString(spawned.details, "workerId") ?? "";
		const paneId = detailNumber(spawned.details, "paneId") ?? -1;
		assert.ok(workerId, "The spawn tool returned no worker id");
		assert.ok(paneId > 0, "The spawn tool returned no pane id");

		// --- the pane is alive ---
		const alive = await waitFor(() => currentPanes().includes(paneId), 30_000, 500);
		assert.ok(alive, "The worker pane never appeared");

		// --- peek shows the pane ---
		const peeked = await host.call("wezterm_worker_peek", { workerId });
		assert.equal(peeked.isError, undefined);
		assert.ok(host.text(peeked).length > 0, "The peek tool returned nothing. The pane holds text.");

		// --- steer reaches the worker ---
		//
		// The tool sends the instruction once. It reports a confirmed
		// delivery only when the transcript records the instruction. A
		// worker that is busy can leave the delivery unconfirmed, and the
		// tool then says so. The test reads the transcript below, so the
		// receipt is proved there and not by the reply of the tool.
		const steered = await host.call("wezterm_worker_steer", {
			workerId,
			message: "Stop counting. Reply with the word STEERED and nothing else.",
		});
		const confirmed = steered.isError === undefined;
		if (confirmed) {
			assert.match(host.text(steered), /Sent to worker/);
			assert.equal(detailNumber(steered.details, "steers"), 1);
		} else {
			assert.match(host.text(steered), /Could not confirm the instruction/);
		}

		// --- the worker receives the steering message ---
		//
		// The worker may finish the original task before the steering message
		// arrives. That is a valid race, not a failure. The behaviour under
		// test is that the steering message reaches the worker, so the test
		// reads the transcript and looks for it there.
		const sessionDir = join(stateDir, "sessions", workerId);
		const received = await waitFor(
			() => {
				const messages = readTranscript(sessionDir);
				return messages.some((m) => m.role === "user" && m.text.includes("Stop counting"));
			},
			60_000,
			500,
		);
		assert.ok(received, "The steering message never reached the worker's transcript");

		// --- the worker answers the steering message ---
		//
		// The worker reports its task state. A report is the strongest
		// evidence that the worker saw the steering message, so the test
		// accepts a report or an answer.
		const answered = await waitFor(
			() => {
				const reports = readReports(sessionDir);
				if (reports.length > 0) return true;
				return answerAfterLastUser(readTranscript(sessionDir)) !== null;
			},
			180_000,
			1000,
		);
		assert.ok(answered, "The worker did not answer the steering message");

		const reports = readReports(sessionDir);
		const answer = answerAfterLastUser(readTranscript(sessionDir));
		if (reports.length === 0) {
			assert.match(
				answer ?? "",
				/STEERED/,
				`The worker answered the steering message with something else: ${answer ?? "(none)"}`,
			);
		}
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

test("a running worker can be cancelled and only its pane closes", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-cancel-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-live-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	const panesBefore = currentPanes();

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: LONG_TASK,
			cwd: repo,
			label: "cancel",
		});
		const workerId = detailString(spawned.details, "workerId") ?? "";
		const paneId = detailNumber(spawned.details, "paneId") ?? -1;
		assert.ok(workerId, "The spawn tool returned no worker id");

		const alive = await waitFor(() => currentPanes().includes(paneId), 30_000, 500);
		assert.ok(alive, "The worker pane never appeared");

		const cancelled = await host.call("wezterm_worker_cancel", { workerId });
		assert.equal(cancelled.isError, undefined, `The cancel tool failed: ${host.text(cancelled)}`);
		assert.equal(detailString(cancelled.details, "status"), "cancelled");
		assert.equal(detailBoolean(cancelled.details, "stopped"), true);

		// --- the pane of the worker closes ---
		const closed = await waitFor(() => !currentPanes().includes(paneId), 30_000, 500);
		assert.ok(closed, "The pane of the cancelled worker is still open");

		// --- the other panes survive ---
		const panesAfter = currentPanes();
		for (const pane of panesBefore) {
			assert.ok(panesAfter.includes(pane), `The cancel closed pane ${pane}, which it did not create`);
		}
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

test("a worker past its deadline is stopped and its pane is confirmed closed", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-deadline-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-live-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));

	const panesBefore = currentPanes();

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: LONG_TASK,
			cwd: repo,
			label: "deadline",
			timeoutMs: 5_000,
		});
		const workerId = detailString(spawned.details, "workerId") ?? "";
		const paneId = detailNumber(spawned.details, "paneId") ?? -1;
		assert.ok(workerId, "The spawn tool returned no worker id");

		const alive = await waitFor(() => currentPanes().includes(paneId), 30_000, 500);
		assert.ok(alive, "The worker pane never appeared");

		const workerRow = async (): Promise<{ status: string | null; error: string | null }> => {
			const result = await host.call("wezterm_worker_status", { workerId });
			const details = result.details;
			if (typeof details !== "object" || details === null || !("workers" in details)) {
				return { status: null, error: null };
			}
			const first: unknown = Array.isArray(details.workers) ? details.workers[0] : null;
			return { status: detailString(first, "status"), error: detailString(first, "error") };
		};
		const failed = await waitFor(async () => (await workerRow()).status === "failed", 120_000, 1_000);
		assert.ok(failed, "The worker never reached the failed status");

		const row = await workerRow();
		assert.match(row.error ?? "", /timed out/);
		assert.ok(!currentPanes().includes(paneId), "The pane of the stopped worker is still open");

		const panesAfter = currentPanes();
		for (const pane of panesBefore) {
			assert.ok(panesAfter.includes(pane), `The deadline closed pane ${pane}, which it did not create`);
		}
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

test("a session releases the worker that it started, and the worker keeps running", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-release-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-live-state-"));
	const host = createHost({ stateDir, cwd: repo, sessionId: "session-release" });
	await host.fire("session_start", sessionContext(repo, "session-release"));

	try {
		const spawned = await host.call("wezterm_spawn_worker", {
			task: LONG_TASK,
			cwd: repo,
			label: "release",
		});
		const workerId = detailString(spawned.details, "workerId") ?? "";
		const paneId = detailNumber(spawned.details, "paneId") ?? -1;
		assert.ok(workerId, "The spawn tool returned no worker id");

		const released = await host.call("wezterm_worker_release", { workerId });
		assert.equal(released.isError, undefined, `The release tool failed: ${host.text(released)}`);
		assert.equal(detailBoolean(released.details, "released"), true);

		// The authority moved. The worker itself stays alive.
		assert.ok(currentPanes().includes(paneId), "The release closed the pane of the worker");
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

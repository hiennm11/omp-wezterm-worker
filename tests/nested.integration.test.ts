/**
 * The launch limits, with a real worker in a real pane.
 *
 * A worker process loads this extension from the OMP plugin link, so it has
 * the spawn tool. The code must refuse that call. The host in this test acts
 * as the main session and fires `input` as one user prompt.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHost, currentPanes, detailString, removeDir, sessionContext, waitFor } from "./harness.ts";

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

test("a worker cannot launch a worker", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-nested-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-nested-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));
	await host.fire("input", {});

	try {
		const panesBefore = currentPanes();
		const spawned = await host.call("wezterm_spawn_worker", {
			task:
				"Try to launch another worker with the tool wezterm_spawn_worker and the task 'Reply OK'. " +
				"If the tool is not available, do not look for it and do not read any file. " +
				"Report the task as completed with wezterm_worker_report. " +
				"Put the outcome of the attempt in the result.",
			cwd: repo,
			label: "nested",
		});
		const workerId = detailString(spawned.details, "workerId") ?? "";
		assert.ok(workerId, `The spawn tool returned no worker id: ${host.text(spawned)}`);

		const finished = await waitFor(
			async () => {
				const status = await host.call("wezterm_worker_status", { workerId });
				return /COMPLETED|FAILED|CANCELLED/.test(host.text(status));
			},
			180_000,
			1000,
		);
		const status = await host.call("wezterm_worker_status", { workerId });
		assert.ok(finished, `The worker did not finish: ${host.text(status)}`);
		assert.match(host.text(status), /COMPLETED/, `The worker did not complete: ${host.text(status)}`);

		const delivered = await waitFor(() => host.delivered.some((t) => t.includes(workerId)), 20_000, 250);
		assert.ok(delivered, "The extension did not deliver the result");
		const result = host.delivered.find((t) => t.includes(workerId)) ?? "";
		// A worker process gets the report tool only. It has no spawn tool, so
		// the worker reports that it could not launch one. The wording of the
		// report is the worker's own, so the check looks for the facts.
		assert.match(result, /finished/, "The worker did not finish");
		assert.match(result, /not (available|present)|No such tool|cannot launch another worker|not possible/i);

		// Only the worker's own pane may have appeared: it closes when the worker ends.
		const settled = await waitFor(() => currentPanes().every((p) => panesBefore.includes(p)), 20_000, 500);
		assert.ok(settled, "The refused nested launch left a pane open");
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

test("a spawn over the active worker limit is refused", {
	skip: !CAN_RUN ? "omp or wezterm is not available" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-limit-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-limit-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));
	await host.fire("input", {});

	try {
		for (const label of ["first", "second", "third"]) {
			const spawned = await host.call("wezterm_spawn_worker", { task: LONG_TASK, cwd: repo, label });
			assert.ok(
				detailString(spawned.details, "workerId"),
				`The ${label} spawn returned no worker id: ${host.text(spawned)}`,
			);
		}
		const panesAfterThree = currentPanes().sort();

		const fourth = await host.call("wezterm_spawn_worker", { task: "Reply OK", cwd: repo, label: "fourth" });
		assert.equal(fourth.isError, true);
		assert.equal(detailString(fourth.details, "refused"), "maxActiveWorkers");
		assert.deepEqual(currentPanes().sort(), panesAfterThree);
	} finally {
		await host.cleanup();
		removeDir(repo);
	}
});

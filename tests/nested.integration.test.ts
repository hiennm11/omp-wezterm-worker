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
import { workerDiagnostics } from "./diagnostic-helpers.ts";
import { createHost, currentPanes, detailString, removeDir, sessionContext, waitFor } from "./harness.ts";

const ACTIVE_WORKER_WAIT_MS = 30_000;

function hasProgram(name: string): boolean {
	const probe = spawnSync(name, ["--version"], { windowsHide: true, encoding: "utf8" });
	return probe.status === 0 || probe.status === 1;
}

const CAN_RUN = hasProgram("omp") && hasProgram("herdr") && process.env.HERDR_ENV === "1";

/** A task that keeps the worker busy for a while. */
const LONG_TASK =
	"Count from 1 to 200 slowly. Write one number per line into a file named count.txt " +
	"in the current working directory, using the write tool, one number at a time. " +
	"Then reply with the word DONE.";

test("a worker cannot launch a worker", {
	skip: !CAN_RUN ? "omp or herdr is not available, or this is not a Herdr session" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-nested-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-nested-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));
	await host.fire("input", {});

	/* The watcher records every pane that appears while the outer worker
	   runs. A nested worker opens a pane of its own, even when it ends
	   before the check runs.
	   The interval polls the real Herdr CLI. A fake clock cannot drive
	   an external process, so the poll is the only way to see the pane. */
	const panesDuringRun: string[] = [];
	const watch = setInterval(() => {
		for (const pane of currentPanes()) {
			if (!panesDuringRun.includes(pane)) panesDuringRun.push(pane);
		}
	}, 250);

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
		assert.match(result, /finished/, "The worker did not finish");

		/* A worker process holds the report tool only. It has no spawn tool,
		   so the nested launch never happens. A nested worker would open a
		   pane of its own. The check watches the pane list while the outer
		   worker runs, so a pane that opens and closes again is caught too.
		   The pane of the outer worker is the one pane that may appear. */
		const workerPane = detailString(spawned.details, "paneId");
		assert.deepEqual(
			panesDuringRun.filter((p) => !panesBefore.includes(p) && p !== workerPane),
			[],
			"The nested launch opened a pane",
		);
		const settled = await waitFor(() => currentPanes().every((p) => panesBefore.includes(p)), 20_000, 500);
		assert.ok(settled, "The refused nested launch left a pane open");
	} finally {
		clearInterval(watch);
		await host.cleanup();
		removeDir(repo);
	}
});

test("a spawn over the active worker limit is refused", {
	skip: !CAN_RUN ? "omp or herdr is not available, or this is not a Herdr session" : false,
}, async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-limit-"));
	const stateDir = mkdtempSync(join(tmpdir(), "wt-limit-state-"));
	const host = createHost({ stateDir, cwd: repo });
	await host.fire("session_start", sessionContext(repo));
	await host.fire("input", {});

	try {
		const workerIds: string[] = [];
		for (const [index, label] of ["first", "second", "third"].entries()) {
			const task = LONG_TASK.replace("count.txt", `count-${label}.txt`);
			const spawned = await host.call("wezterm_spawn_worker", { task, cwd: repo, label });
			const workerId = detailString(spawned.details, "workerId");
			assert.ok(workerId, `The ${label} spawn returned no worker id: ${host.text(spawned)}`);
			workerIds[index] = workerId;
		}
		const active = async () => {
			const rows = await Promise.all(
				workerIds.map(async (workerId) => {
					const result = await host.call("wezterm_worker_status", { workerId });
					const workers =
						result.details && typeof result.details === "object" && "workers" in result.details
							? result.details.workers
							: null;
					if (Array.isArray(workers) && workers[0] && typeof workers[0] === "object") {
						const row = workers[0];
						if ("workerId" in row && "status" in row && "error" in row && "paneId" in row) {
							return {
								workerId: typeof row.workerId === "string" ? row.workerId : workerId,
								status: typeof row.status === "string" ? row.status : "unknown",
								error: typeof row.error === "string" ? row.error : null,
								paneId: typeof row.paneId === "string" ? row.paneId : null,
							};
						}
					}
					return { workerId, status: "unknown", error: host.text(result), paneId: null };
				}),
			);
			return rows;
		};
		const ready = await waitFor(
			async () => (await active()).every((worker) => worker.status === "running"),
			ACTIVE_WORKER_WAIT_MS,
		);
		const statuses = await active();
		const paneIds = currentPanes();
		const diagnostics = workerDiagnostics(
			statuses.map((worker) => ({
				workerId: worker.workerId,
				status: worker.status,
				error: worker.error,
				paneState: `paneId=${worker.paneId ?? "(none)"}, open=${worker.paneId !== null && paneIds.includes(worker.paneId)}`,
			})),
		);
		assert.ok(ready, `Workers did not all become active within ${ACTIVE_WORKER_WAIT_MS}ms:\n${diagnostics}`);
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

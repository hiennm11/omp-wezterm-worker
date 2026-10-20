import assert from "node:assert/strict";
import { test } from "node:test";

import { activeSharers, freshRunState, type Job } from "../extensions/lib/job.ts";

function job(id: string, sessionDir: string, status: Job["status"]): Job {
	return {
		id,
		label: id,
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status,
	};
}

test("a resumed worker that is still running blocks cleanup of the old worker", () => {
	const old = job("wz-1", "/s/wz-1", "completed");
	const resumed = job("wz-2", "/s/wz-1", "running");
	assert.deepEqual(
		activeSharers([old, resumed], old).map((j) => j.id),
		["wz-2"],
	);
});

test("finished or unrelated workers do not block cleanup", () => {
	const old = job("wz-1", "/s/wz-1", "completed");
	const finished = job("wz-2", "/s/wz-1", "failed");
	const other = job("wz-3", "/s/wz-3", "running");
	assert.deepEqual(activeSharers([old, finished, other], old), []);
});

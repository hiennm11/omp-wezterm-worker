import assert from "node:assert/strict";
import { test } from "node:test";

import { workerDiagnostics, worktreeDiagnostics } from "./diagnostic-helpers.ts";

test("worker diagnostics name an early status and error", () => {
	const message = workerDiagnostics([
		{ workerId: "wz-early", status: "failed", error: "pane exited", paneState: "paneId=41, open=false" },
	]);
	assert.match(message, /wz-early: status=failed/);
	assert.match(message, /error=pane exited/);
});

test("worktree diagnostics include worker and git state", () => {
	const message = worktreeDiagnostics("failed", "pane exited", "?? worker-output.txt");
	assert.match(message, /status=failed/);
	assert.match(message, /error=pane exited/);
	assert.match(message, /\?\? worker-output\.txt/);
});

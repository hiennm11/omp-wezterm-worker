import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHost, sessionContext } from "./harness.ts";

/** The tools that the agent can call. A name is part of the public contract. */
const EXPECTED_TOOLS = [
	"wezterm_spawn_worker",
	"wezterm_worker_status",
	"wezterm_worker_ack",
	"wezterm_worker_steer",
	"wezterm_worker_peek",
	"wezterm_worker_result",
	"wezterm_worker_resume",
	"wezterm_worker_cancel",
	"wezterm_worker_cleanup",
	"wezterm_worker_resolve",
	"wezterm_worker_release",
];

test("the extension registers every tool that the agent needs", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wt-registration-"));
	const host = createHost({ cwd });
	try {
		await host.fire("session_start", sessionContext(cwd));
		assert.deepEqual([...host.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
	} finally {
		await host.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the extension registers the roster command", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wt-registration-"));
	const host = createHost({ cwd });
	try {
		await host.fire("session_start", sessionContext(cwd));
		assert.deepEqual(host.commands, ["wezterm-workers"]);
	} finally {
		await host.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
});

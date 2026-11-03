/**
 * The errors that the polls of the worker collected.
 *
 * A failed poll must reach the logger of the host. The last errors of a
 * session reach it when the session shuts down.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHost, RUNTIME, sessionContext } from "./harness.ts";

test("the errors of a session reach the logger when the session shuts down", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wt-drain-"));
	const host = createHost({ cwd });
	try {
		RUNTIME.errors.push("the poll of the worker failed");
		await host.fire("session_shutdown", sessionContext(cwd));
		assert.deepEqual(host.loggedErrors, ["[wezterm-worker] the poll of the worker failed"]);
	} finally {
		await host.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the extension registers no handler for an event that the host does not emit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wt-drain-"));
	const host = createHost({ cwd });
	try {
		const events = host.handlers.map((entry) => entry.event);
		assert.equal(events.includes("session_end"), false, "OMP emits no session_end event");
		assert.equal(events.includes("session_shutdown"), true, "the session end handler exists");
		assert.equal(events.includes("tool_result"), true, "the tool result handler exists");
	} finally {
		await host.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	}
});

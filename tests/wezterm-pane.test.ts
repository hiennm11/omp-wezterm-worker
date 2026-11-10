/**
 * The panes of WezTerm.
 *
 * The tests protect the rules of the pane runtime:
 *
 * - a launch opens a pane and starts the program with the task in the argv;
 * - a send goes through `send-text --no-paste`, so the composer submits;
 * - a pane state comes from the pane list of the CLI;
 * - a close uses `kill-pane`;
 * - a pane id that is not a number is an error, never a null.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { closePaneConfirmed, killPane, paneState, paneStatesOf, sendToPane } from "../extensions/lib/pane.ts";
import { launchProgram } from "../extensions/lib/pane-launch.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { type WeztermFake, weztermFake } from "./wezterm-fake.ts";

/** A job of a worker that runs in WezTerm. */
function worker(): Job {
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "running",
		paneId: "7",
		runtime: "wezterm",
	};
}

/** A runtime whose WezTerm answers with the given fake. */
function runtimeWith(fake: WeztermFake): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.wezterm = async (args) => fake.answer(args);
	rt.paneRuntime = "wezterm";
	return rt;
}

test("a launch opens a pane and starts the worker with the task in the argv", async () => {
	const fake = weztermFake();
	const rt = runtimeWith(fake);
	try {
		const job = worker();
		const failure = await launchProgram(rt, job, "omp", ["--no-title"], undefined, "do the task");
		assert.equal(failure, null, `the launch failed: ${failure}`);
		const split = fake.calls.find((args) => args[0] === "split-pane");
		assert.ok(split, "the launch did not split a pane");
		assert.deepEqual(split.slice(0, 4), ["split-pane", "--right", "--cwd", "/repo"]);
		const started = fake.started.at(-1) ?? [];
		assert.deepEqual(started, ["omp", "--no-title", "do the task"], "the task was not one argv element");
		assert.equal(job.paneId, "100", "the job holds no pane id");
		assert.equal(job.status, "running");
	} finally {
		rt.closeDb();
	}
});

test("a launch with a tab opens a tab", async () => {
	const fake = weztermFake();
	const rt = runtimeWith(fake);
	try {
		const job = { ...worker(), placement: "tab" as const };
		const failure = await launchProgram(rt, job, "omp", ["--no-title"]);
		assert.equal(failure, null, `the launch failed: ${failure}`);
		const spawn = fake.calls.find((args) => args[0] === "spawn");
		assert.ok(spawn, "the launch did not spawn a pane");
	} finally {
		rt.closeDb();
	}
});

test("a send goes through the send-text verb and ends with the Enter key", async () => {
	const fake = weztermFake();
	const rt = runtimeWith(fake);
	try {
		const sent = await sendToPane(rt, worker(), "focus on the parser only");
		assert.equal(sent.ok, true);
		const call = fake.calls.find((args) => args[0] === "send-text");
		assert.ok(call, "the extension did not send the text");
		assert.deepEqual(call, [
			"send-text",
			"--no-paste",
			"--pane-id",
			"7",
			"focus on the parser only\r",
		]);
	} finally {
		rt.closeDb();
	}
});

test("a refused send is not a delivery", async () => {
	const fake = weztermFake({ failSendText: true });
	const rt = runtimeWith(fake);
	try {
		const sent = await sendToPane(rt, worker(), "focus on the parser only");
		assert.equal(sent.ok, false);
		assert.ok(sent.error);
		assert.deepEqual(fake.sends, []);
	} finally {
		rt.closeDb();
	}
});

test("a pane of the pane list is present", async () => {
	const fake = weztermFake({ panes: [{ paneId: 7, tabId: 1, windowId: 0 }] });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await paneState(rt, worker()), "present");
		assert.equal(await paneState(rt, { ...worker(), paneId: "9" }), "gone");
	} finally {
		rt.closeDb();
	}
});

test("an unreadable pane list is unknown and never gone", async () => {
	const fake = weztermFake({ listCode: 1 });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await paneState(rt, worker()), "unknown");
	} finally {
		rt.closeDb();
	}
});

test("the state of every pane id comes from one pane list", async () => {
	const fake = weztermFake({ panes: [{ paneId: 7, tabId: 1, windowId: 0 }] });
	const rt = runtimeWith(fake);
	try {
		const states = await paneStatesOf(rt, [worker(), { ...worker(), paneId: "9" }]);
		assert.equal(states.get("7"), "present");
		assert.equal(states.get("9"), "gone");
		const lists = fake.calls.filter((args) => args[0] === "list");
		assert.equal(lists.length, 1, "the extension read the pane list more than once");
	} finally {
		rt.closeDb();
	}
});

test("a close uses the kill-pane verb", async () => {
	const fake = weztermFake({ panes: [{ paneId: 7, tabId: 1, windowId: 0 }] });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await killPane(rt, worker()), null);
		const kills = fake.calls.filter((args) => args[0] === "kill-pane");
		assert.deepEqual(kills, [["kill-pane", "--pane-id", "7"]]);
	} finally {
		rt.closeDb();
	}
});

test("a close is confirmed only when the pane list no longer holds the pane", async () => {
	const fake = weztermFake({ panes: [{ paneId: 7, tabId: 1, windowId: 0 }] });
	const rt = runtimeWith(fake);
	rt.stopConfirm = { attempts: 3, intervalMs: 1 };
	try {
		const reason = await closePaneConfirmed(rt, worker());
		assert.equal(reason, null, `the close was not confirmed: ${reason}`);
		assert.deepEqual(fake.closed, ["7"]);
		assert.equal(fake.panes.has("7"), false, "the pane stayed in the list");
	} finally {
		rt.closeDb();
	}
});

test("a pane id that is not a number is an error, not a null", async () => {
	const fake = weztermFake();
	const rt = runtimeWith(fake);
	try {
		const sent = await sendToPane(rt, { ...worker(), paneId: "w4:p1" }, "text");
		assert.equal(sent.ok, false);
		assert.match(sent.error ?? "", /not a WezTerm pane id/);
		const killed = await killPane(rt, { ...worker(), paneId: "w4:p1" });
		assert.match(killed ?? "", /not a WezTerm pane id/);
		assert.deepEqual(fake.calls, [], "the CLI received a call for a broken pane id");
	} finally {
		rt.closeDb();
	}
});

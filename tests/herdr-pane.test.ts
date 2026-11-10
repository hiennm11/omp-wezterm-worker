/**
 * The panes of Herdr.
 *
 * The tests protect the rules of ADR 0025 and ADR 0006:
 *
 * - a pane id is a string such as `w4:p1`, and Herdr names it;
 * - an unreadable pane list gives `unknown`, never `gone`;
 * - a stop is confirmed only when the pane list no longer holds the pane;
 * - a steering message goes through `agent prompt`, and it sends the text
 *   once;
 * - a launch keeps a task with spaces, quotes and `$(...)` as one argv
 *   element.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import {
	closePaneConfirmed,
	killPane,
	launchProgram,
	paneState,
	paneStatesOf,
	sendToPane,
} from "../extensions/lib/pane.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { herdrFake, type HerdrFake } from "./herdr-fake.ts";

/** A job of a worker that runs. */
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
		paneId: "w4:p1",
	};
}

/** A runtime whose Herdr answers with the given fake. */
function runtimeWith(fake: HerdrFake): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.herdr = async (args) => fake.answer(args);
	return rt;
}

test("a pane of the pane list is present", async () => {
	const fake = herdrFake({ panes: [{ paneId: "w4:p1", tabId: "w4:t1" }] });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await paneState(rt, "w4:p1"), "present");
		assert.equal(await paneState(rt, "w4:p9"), "gone");
	} finally {
		rt.closeDb();
	}
});

test("an unreadable pane list is unknown and never gone", async () => {
	const fake = herdrFake({ listCode: 1 });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await paneState(rt, "w4:p1"), "unknown");
	} finally {
		rt.closeDb();
	}
});

test("a pane list that holds no pane list is unknown and never gone", async () => {
	const fake = herdrFake({ brokenList: true });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await paneState(rt, "w4:p1"), "unknown");
	} finally {
		rt.closeDb();
	}
});

test("the state of every pane id comes from one pane list", async () => {
	const fake = herdrFake({ panes: [{ paneId: "w4:p1", tabId: "w4:t1" }] });
	const rt = runtimeWith(fake);
	try {
		const states = await paneStatesOf(rt, ["w4:p1", "w4:p2"]);
		assert.equal(states.get("w4:p1"), "present");
		assert.equal(states.get("w4:p2"), "gone");
		const lists = fake.calls.filter((args) => args[0] === "pane" && args[1] === "list");
		assert.equal(lists.length, 1, "the extension read the pane list more than once");
	} finally {
		rt.closeDb();
	}
});

test("a close is confirmed only when the pane list no longer holds the pane", async () => {
	const fake = herdrFake({ panes: [{ paneId: "w4:p1", tabId: "w4:t1" }] });
	const rt = runtimeWith(fake);
	rt.stopConfirm = { attempts: 3, intervalMs: 1 };
	try {
		const reason = await closePaneConfirmed(rt, "w4:p1");
		assert.equal(reason, null, `the close was not confirmed: ${reason}`);
		assert.deepEqual(fake.closed, ["w4:p1"]);
		assert.equal(fake.panes.has("w4:p1"), false, "the pane stayed in the list");
	} finally {
		rt.closeDb();
	}
});

test("a close that the pane list cannot confirm is not confirmed", async () => {
	const fake = herdrFake({ listCode: 1 });
	const rt = runtimeWith(fake);
	rt.stopConfirm = { attempts: 2, intervalMs: 1 };
	try {
		const reason = await closePaneConfirmed(rt, "w4:p1");
		assert.ok(reason, "the close was confirmed without a readable pane list");
		assert.match(reason, /pane list cannot be read/);
	} finally {
		rt.closeDb();
	}
});

test("a steering message goes through the agent prompt and sends the text once", async () => {
	const fake = herdrFake();
	const rt = runtimeWith(fake);
	try {
		const sent = await sendToPane(rt, "w4:p1", "focus on the parser only");
		assert.equal(sent.ok, true);
		assert.deepEqual(fake.prompts, ["focus on the parser only"]);
		const prompts = fake.calls.filter((args) => args[0] === "agent" && args[1] === "prompt");
		assert.equal(prompts.length, 1, "the extension sent the instruction more than once");
	} finally {
		rt.closeDb();
	}
});

test("a refused steering message is not a delivery", async () => {
	const fake = herdrFake({ failAgentPrompt: true });
	const rt = runtimeWith(fake);
	try {
		const sent = await sendToPane(rt, "w4:p1", "focus on the parser only");
		assert.equal(sent.ok, false);
		assert.ok(sent.error);
		assert.deepEqual(fake.prompts, []);
	} finally {
		rt.closeDb();
	}
});

test("a close of a pane uses the pane close verb", async () => {
	const fake = herdrFake({ panes: [{ paneId: "w4:p1", tabId: "w4:t1" }] });
	const rt = runtimeWith(fake);
	try {
		assert.equal(await killPane(rt, "w4:p1"), null);
		const closes = fake.calls.filter((args) => args[0] === "pane" && args[1] === "close");
		assert.deepEqual(closes, [["pane", "close", "w4:p1"]]);
	} finally {
		rt.closeDb();
	}
});

test("a task with spaces, quotes and a substitution stays one argv element", async () => {
	const fake = herdrFake();
	const rt = runtimeWith(fake);
	try {
		const task = 'say "A B" $(x) & y';
		const failure = await launchProgram(rt, worker(), "omp", ["--no-title", task]);
		assert.equal(failure, null, `the launch failed: ${failure}`);
		const start = fake.started.at(-1) ?? [];
		assert.deepEqual(start, ["--no-title", task], "the task was not one argv element");
		assert.equal(rt.jobs.get("wz-1"), undefined);
	} finally {
		rt.closeDb();
	}
});

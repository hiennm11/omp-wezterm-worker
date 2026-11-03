import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireTask, bindSession, generationOf } from "../extensions/lib/owner.ts";
import {
	acquireOwnership,
	beginRelease,
	checkAuthority,
	commitRelease,
	readOwnership,
} from "../extensions/lib/ownership.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

const OWN_START = "2026-10-23T01:00:00.000Z";
const OLD_START = "2026-10-22T08:00:00.000Z";

/** A runtime whose process table answers every query with `table`. */
function fakeRuntime(table: { code: number; stdout: string }): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-owner-"));
	const exec: RunFn = async () => ({ code: table.code, stdout: table.stdout, stderr: "" });
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.processId = 500;
	rt.processStartedAt = OWN_START;
	return { rt, dir };
}

function viewOf(id: string | null) {
	return { getSessionId: () => id };
}

function finish(rt: WorkerRuntime, dir: string): void {
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

/** Store the ownership of the task wz-1 as it was before this process started. */
function seedOwner(rt: WorkerRuntime, sessionId: string, pid: number, startedAt: string): void {
	acquireOwnership(rt.openDb(), "task-wz-1", sessionId, pid, startedAt, 1000);
}

function ownerOf(rt: WorkerRuntime) {
	return readOwnership(rt.openDb(), "task-wz-1").owner;
}

/**
 * Give the runtime a lease probe.
 *
 * The probe answers for the session that calls it. A null answer means that
 * the host cannot probe the lease.
 */
function withLease(rt: WorkerRuntime, held: boolean | null): WorkerRuntime {
	rt.sessionLeaseHeld = async () => held;
	return rt;
}

test("a session that starts a worker owns the task with generation 1", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "" });
	try {
		bindSession(rt, viewOf("session-a"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, true);
		assert.equal(generationOf(rt, "wz-1"), 1);
		assert.equal(ownerOf(rt)?.sessionId, "session-a");
		assert.equal(ownerOf(rt)?.processId, 500);
	} finally {
		finish(rt, dir);
	}
});

test("a session without an identity acquires nothing and may still supervise", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "" });
	try {
		bindSession(rt, viewOf(null));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.equal(result.acquired ? "" : result.kind, "no-identity");
		assert.equal(ownerOf(rt), null);
	} finally {
		finish(rt, dir);
	}
});

test("the same session acquires its task again in the same process and the generation moves on", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "" });
	try {
		bindSession(rt, viewOf("session-a"));
		await acquireTask(rt, "wz-1");
		const again = await acquireTask(rt, "wz-1");
		assert.equal(again.acquired, true);
		assert.equal(generationOf(rt, "wz-1"), 2);
	} finally {
		finish(rt, dir);
	}
});

test("the same session acquires its task after a restart when the old process is gone", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "" });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, true);
		assert.equal(ownerOf(rt)?.processId, 500);
		assert.equal(generationOf(rt, "wz-1"), 2);
	} finally {
		finish(rt, dir);
	}
});

test("a second live process of the same session does not take the task from the first", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: `${OLD_START}\n` });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.equal(result.acquired ? "" : result.kind, "owned");
		assert.equal(ownerOf(rt)?.processId, 900);
		assert.equal(generationOf(rt, "wz-1"), 1);
	} finally {
		finish(rt, dir);
	}
});

test("a reused process id does not count as the previous owner", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "2026-10-23T05:00:00.000Z\n" });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, true);
	} finally {
		finish(rt, dir);
	}
});

test("an unreadable process table refuses the acquisition", async () => {
	const { rt, dir } = fakeRuntime({ code: 1, stdout: "" });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.equal(result.acquired ? "" : result.kind, "unknown");
		assert.equal(ownerOf(rt)?.processId, 900);
	} finally {
		finish(rt, dir);
	}
});

test("another session never takes a task, even when the old process is gone", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "" });
	try {
		seedOwner(rt, "session-old", 900, OLD_START);
		bindSession(rt, viewOf("session-new"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.match(result.acquired ? "" : result.reason, /session-old.*Take over explicitly/);
		assert.equal(ownerOf(rt)?.sessionId, "session-old");
		assert.equal(generationOf(rt, "wz-1"), null);
	} finally {
		finish(rt, dir);
	}
});

test("a released task of another session waits for an explicit takeover", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: "" });
	try {
		seedOwner(rt, "session-old", 900, OLD_START);
		beginRelease(rt.openDb(), "task-wz-1", "session-old", 1, 1100);
		commitRelease(rt.openDb(), "task-wz-1", "session-old", 1, 1200);
		bindSession(rt, viewOf("session-new"));
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.match(result.acquired ? "" : result.reason, /released.*Take over explicitly/);
		assert.equal(ownerOf(rt)?.sessionId, "session-old");
		assert.equal(ownerOf(rt)?.phase, "released");
	} finally {
		finish(rt, dir);
	}
});

test("a session takes its task back when the lease of the session is free", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: `${OLD_START}\n` });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		withLease(rt, false);
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, true);
		assert.equal(generationOf(rt, "wz-1"), 2);
		assert.equal(ownerOf(rt)?.processId, 500);
	} finally {
		finish(rt, dir);
	}
});

test("a session keeps its task while a process holds the lease of the session", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: `${OLD_START}\n` });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		withLease(rt, true);
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.equal(result.acquired ? "" : result.kind, "owned");
		assert.equal(ownerOf(rt)?.processId, 900);
		assert.equal(generationOf(rt, "wz-1"), 1);
	} finally {
		finish(rt, dir);
	}
});

test("a session keeps its task while the host cannot answer about the lease", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: `${OLD_START}\n` });
	try {
		seedOwner(rt, "session-a", 900, OLD_START);
		bindSession(rt, viewOf("session-a"));
		withLease(rt, null);
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.equal(result.acquired ? "" : result.kind, "owned");
		assert.equal(ownerOf(rt)?.processId, 900);
		assert.equal(generationOf(rt, "wz-1"), 1);
	} finally {
		finish(rt, dir);
	}
});

test("another session takes no task even when the lease is free", async () => {
	const { rt, dir } = fakeRuntime({ code: 0, stdout: `${OLD_START}\n` });
	try {
		seedOwner(rt, "session-old", 900, OLD_START);
		bindSession(rt, viewOf("session-new"));
		withLease(rt, false);
		const result = await acquireTask(rt, "wz-1");
		assert.equal(result.acquired, false);
		assert.equal(result.acquired ? "" : result.kind, "owned");
		assert.match(result.acquired ? "" : result.reason, /session-old.*Take over explicitly/);
		assert.equal(ownerOf(rt)?.sessionId, "session-old");
	} finally {
		finish(rt, dir);
	}
});

test("a stale owner of the same session cannot write after the second process took the task", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-owner-two-"));
	const exec: RunFn = async () => ({ code: 0, stdout: `${OWN_START}\n`, stderr: "" });
	const first = createRuntime(exec);
	first.config.stateDir = dir;
	first.processId = 500;
	first.processStartedAt = OWN_START;
	const second = createRuntime(exec);
	second.config.stateDir = dir;
	second.processId = 600;
	second.processStartedAt = OWN_START;
	try {
		bindSession(first, viewOf("session-a"));
		withLease(first, false);
		const firstTake = await acquireTask(first, "wz-1");
		assert.equal(firstTake.acquired, true);
		const firstGeneration = generationOf(first, "wz-1");
		assert.equal(firstGeneration, 1);

		bindSession(second, viewOf("session-a"));
		withLease(second, false);
		const secondTake = await acquireTask(second, "wz-1");
		assert.equal(secondTake.acquired, true);
		assert.equal(generationOf(second, "wz-1"), 2);
		assert.equal(readOwnership(second.openDb(), "task-wz-1").owner?.processId, 600);

		const authority = checkAuthority(first.openDb(), "task-wz-1", "session-a", firstGeneration ?? 0);
		assert.equal(authority.ok, false);
		assert.match(authority.reason, /new generation/);
	} finally {
		first.closeDb();
		second.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

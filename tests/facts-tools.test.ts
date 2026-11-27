/**
 * The tools of the facts.
 *
 * The tests drive the tools through their real code path, with real files
 * in a temporary directory. A worker proposes a fact. The main session
 * promotes it, lists it and retracts it.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { promotedFactsFile, proposedFactsFile, readProposedFacts } from "../extensions/lib/facts-store.ts";
import { registerFactsTool } from "../extensions/worker-tools/facts.ts";
import { registerProposeFactTool } from "../extensions/worker-tools/propose-fact.ts";
import { makeJob } from "./takeover-helpers.ts";
import {
	asWorker,
	type FakeTool,
	fakeRuntime,
	finish,
	mainToolOf,
	OWN,
	seedOwner,
	workerSession,
	workerToolOf,
} from "./worker-channel-helpers.ts";

test("a proposed fact waits in the session directory of the worker", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		const sessionDir = workerSession(dir, job.id);

		const proposed = await asWorker(sessionDir, () =>
			workerToolOf(rt, registerProposeFactTool, "wezterm_worker_propose_fact").execute("t1", {
				key: "build",
				text: "The build fails on Windows.",
			}),
		);
		assert.equal(proposed.isError, undefined);
		assert.match(proposed.content[0]?.text ?? "", /fact 'build' is proposed/);
		assert.ok(existsSync(proposedFactsFile(sessionDir)), "the worker wrote no proposed file");
		const facts = readProposedFacts(sessionDir);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.writer, "wz-1");
	} finally {
		finish(rt, dir);
	}
});

test("a fact without a key and a fact without text are refused", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		const sessionDir = workerSession(dir, job.id);
		const propose = workerToolOf(rt, registerProposeFactTool, "wezterm_worker_propose_fact");

		const noKey = await asWorker(sessionDir, () => propose.execute("t1", { key: "  ", text: "a text" }));
		assert.equal(noKey.isError, true);
		assert.match(noKey.content[0]?.text ?? "", /needs a key/);

		const noText = await asWorker(sessionDir, () => propose.execute("t2", { key: "build", text: "   " }));
		assert.equal(noText.isError, true);
		assert.match(noText.content[0]?.text ?? "", /needs text/);

		const tooLong = await asWorker(sessionDir, () =>
			propose.execute("t3", { key: "build", text: "x".repeat(4001) }),
		);
		assert.equal(tooLong.isError, true);
		assert.match(tooLong.content[0]?.text ?? "", /at most 4000 characters/);
	} finally {
		finish(rt, dir);
	}
});

test("the main session promotes the proposed fact of a worker", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		await asWorker(sessionDir, () =>
			workerToolOf(rt, registerProposeFactTool, "wezterm_worker_propose_fact").execute("t1", {
				key: "build",
				text: "The build fails on Windows.",
			}),
		);

		const promoted = await mainToolOf(rt, registerFactsTool, "wezterm_worker_facts").execute("t2", {
			action: "promote",
			workerId: job.id,
			key: "build",
		});
		assert.equal(promoted.isError, undefined);
		assert.match(promoted.content[0]?.text ?? "", /fact 'build' of worker wz-1 is promoted/);
		const file = promotedFactsFile(dir, OWN);
		assert.ok(existsSync(file), "the main session wrote no promoted file");
		const line = readFileSync(file, "utf8").trim();
		assert.match(line, /"text":"The build fails on Windows\."/);
	} finally {
		finish(rt, dir);
	}
});

test("the main session lists the promoted facts", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const facts = mainToolOf(rt, registerFactsTool, "wezterm_worker_facts");
		const written = await facts.execute("t1", {
			action: "set",
			key: "build",
			text: "The build fails on Windows.",
		});
		assert.equal(written.isError, undefined);
		assert.match(written.content[0]?.text ?? "", /fact 'build' is promoted/);

		const listed = await facts.execute("t2", { action: "list" });
		assert.equal(listed.isError, undefined);
		assert.match(listed.content[0]?.text ?? "", /build \[promoted\]/);
		assert.match(listed.content[0]?.text ?? "", /The build fails on Windows\./);
	} finally {
		finish(rt, dir);
	}
});

test("a retraction names the worker that keeps its snapshot", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const facts = mainToolOf(rt, registerFactsTool, "wezterm_worker_facts");
		await facts.execute("t1", { action: "set", key: "build", text: "The build fails on Windows." });

		const retracted = await facts.execute("t2", { action: "retract", key: "build" });
		assert.equal(retracted.isError, undefined);
		assert.match(retracted.content[0]?.text ?? "", /fact 'build' is retracted/);
		assert.match(retracted.content[0]?.text ?? "", /keeps its snapshot/);

		const listed = await facts.execute("t3", { action: "list" });
		assert.match(listed.content[0]?.text ?? "", /build \[retracted\]/);
	} finally {
		finish(rt, dir);
	}
});

test("the main session refuses to write without a session identity", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = null;
		const facts = mainToolOf(rt, registerFactsTool, "wezterm_worker_facts");
		const written = await facts.execute("t1", { action: "set", key: "build", text: "a text" });
		assert.equal(written.isError, true);
		assert.match(written.content[0]?.text ?? "", /no identity/);
		assert.equal(existsSync(join(dir, "facts")), false, "the tool wrote a file without an identity");
	} finally {
		finish(rt, dir);
	}
});

test("the main session refuses an unknown action and an unknown worker", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const facts = mainToolOf(rt, registerFactsTool, "wezterm_worker_facts");
		const wrongAction = await facts.execute("t1", { action: "drop" });
		assert.equal(wrongAction.isError, true);
		assert.match(wrongAction.content[0]?.text ?? "", /must be one of/);

		const wrongWorker = await facts.execute("t2", { action: "promote", workerId: "wz-9", key: "build" });
		assert.equal(wrongWorker.isError, true);
		assert.match(wrongWorker.content[0]?.text ?? "", /Unknown worker id: wz-9/);
	} finally {
		finish(rt, dir);
	}
});

test("a worker of another session cannot promote a fact of this session", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		const sessionDir = workerSession(dir, job.id);
		await asWorker(sessionDir, () =>
			workerToolOf(rt, registerProposeFactTool, "wezterm_worker_propose_fact").execute("t1", {
				key: "build",
				text: "The build fails on Windows.",
			}),
		);
		rt.sessionId = "session-other";

		const promoted = await mainToolOf(rt, registerFactsTool, "wezterm_worker_facts").execute("t2", {
			action: "promote",
			workerId: job.id,
			key: "build",
		});
		assert.equal(promoted.isError, true);
		assert.match(promoted.content[0]?.text ?? "", /belongs to session session-new/);
	} finally {
		finish(rt, dir);
	}
});

test("the main session refuses to promote a key that the worker did not propose", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);
		workerSession(dir, job.id);

		const promoted = await mainToolOf(rt, registerFactsTool, "wezterm_worker_facts").execute("t1", {
			action: "promote",
			workerId: job.id,
			key: "missing",
		});
		assert.equal(promoted.isError, true);
		assert.match(promoted.content[0]?.text ?? "", /proposed no fact with the key 'missing'/);
	} finally {
		finish(rt, dir);
	}
});

test("a worker process gets the fact tool and not the tool of the main session", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		const sessionDir = workerSession(dir, job.id);
		const propose: FakeTool = workerToolOf(rt, registerProposeFactTool, "wezterm_worker_propose_fact");
		const proposed = await asWorker(sessionDir, () =>
			propose.execute("t1", { key: "build", text: "The build fails on Windows." }),
		);
		assert.equal(proposed.isError, undefined);
	} finally {
		finish(rt, dir);
	}
});

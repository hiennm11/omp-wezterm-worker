/**
 * The snapshot of the facts that a worker receives at its spawn.
 *
 * The tests drive the spawn tool through its real code path, with real
 * files in a temporary directory. The main session promotes a fact. The
 * spawn writes the fact into the snapshot of the worker, and the prompt of
 * the worker holds the snapshot.
 *
 * A spawn that names a key that does not exist, a retracted key, or too
 * many characters refuses the whole call before any pane opens.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REPORTING_CONTRACT } from "../extensions/lib/bootstrap-prompt.ts";
import { factsSnapshotFile } from "../extensions/lib/facts-snapshot.ts";
import { appendRetraction } from "../extensions/lib/facts-store.ts";
import {
	CONTEXT,
	fakeRuntime,
	openedPane,
	promote,
	sessionDirOf,
	spawnToolOf,
} from "./facts-snapshot-helpers.ts";

test("a spawn with facts writes the snapshot of the promoted facts into the session directory", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		promote(dir, "build", "The build fails on Windows.");
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, facts: ["build"] },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const sessionDir = sessionDirOf(result.details);
		const snapshot = factsSnapshotFile(sessionDir);
		assert.ok(existsSync(snapshot), "the spawn wrote no snapshot");
		const text = readFileSync(snapshot, "utf8");
		assert.match(text, /build/, "the snapshot names no key");
		assert.match(text, /The build fails on Windows\./, "the snapshot holds no text");
		const prompt = readFileSync(join(sessionDir, ".wezterm-worker-prompt.md"), "utf8");
		assert.match(prompt, /The build fails on Windows\./, "the prompt of the worker holds no snapshot");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn with facts writes the snapshot for a Claude worker", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		promote(dir, "build", "The build fails on Windows.");
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, backend: "claude", facts: ["build"] },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const sessionDir = sessionDirOf(result.details);
		assert.ok(existsSync(factsSnapshotFile(sessionDir)), "the spawn wrote no snapshot");
		const contract = readFileSync(join(sessionDir, ".claude-contract.md"), "utf8");
		assert.match(contract, /The build fails on Windows\./, "the contract holds no snapshot");
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn without facts writes no snapshot and gives the same prompt as before", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.notEqual(result.isError, true, result.content[0]?.text);
		const sessionDir = sessionDirOf(result.details);
		assert.equal(existsSync(factsSnapshotFile(sessionDir)), false, "the spawn wrote a snapshot");
		const prompt = readFileSync(join(sessionDir, ".wezterm-worker-prompt.md"), "utf8");
		assert.equal(prompt, REPORTING_CONTRACT, "the prompt of the worker changed");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn with a key that does not exist refuses before any pane opens", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		promote(dir, "build", "The build fails on Windows.");
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, facts: ["build", "missing"] },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /missing/, "the reply names no key");
		assert.equal(openedPane(calls), false, "the refused spawn opened a pane");
		assert.equal(rt.jobs.size, 0, "the refused spawn started a worker");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn with a retracted key refuses before any pane opens", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		promote(dir, "build", "The build fails on Windows.");
		appendRetraction(dir, "session-1", { key: "build", writer: "session-1", at: 200 });
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, facts: ["build"] },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /build/, "the reply names no key");
		assert.equal(openedPane(calls), false, "the refused spawn opened a pane");
		assert.equal(rt.jobs.size, 0, "the refused spawn started a worker");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn with texts that hold more than 16000 characters refuses before any pane opens", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		promote(dir, "first", "x".repeat(9000));
		promote(dir, "second", "y".repeat(9000));
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, facts: ["first", "second"] },
			undefined,
			undefined,
			CONTEXT,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /16000/, "the reply names no size");
		assert.equal(openedPane(calls), false, "the refused spawn opened a pane");
		assert.equal(rt.jobs.size, 0, "the refused spawn started a worker");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn with facts and a session without an identity refuses before any pane opens", async () => {
	const { rt, dir, calls } = fakeRuntime();
	try {
		promote(dir, "build", "The build fails on Windows.");
		rt.sessionId = null;
		const tool = spawnToolOf(rt);
		const result = await tool.execute(
			"t1",
			{ task: "Read baseline.txt.", cwd: dir, facts: ["build"] },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getSessionFile: () => null, getSessionId: () => null } },
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /no identity/, "the reply names no identity");
		assert.equal(openedPane(calls), false, "the refused spawn opened a pane");
		assert.equal(rt.jobs.size, 0, "the refused spawn started a worker");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

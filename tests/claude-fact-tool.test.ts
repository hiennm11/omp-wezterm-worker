/**
 * The fact tool of a Claude Code worker.
 *
 * The mod of the worker never reads a fact file. It calls the bridge of the
 * run, and the bridge writes the file. The test drives the mod against a
 * real bridge.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startBridge } from "../extensions/lib/claude-bridge.ts";
import { readProposedFacts } from "../extensions/lib/facts-store.ts";
import { startMod, toolResult } from "./claude-note-helpers.ts";

/** The name of the tool that proposes a fact. */
const PROPOSE_FACT = "wezterm_worker_propose_fact";

/** The name that the native host uses for the fact tool. */
const MCP_PROPOSE_FACT = `mcp__wezterm-worker__${PROPOSE_FACT}`;

/** The bridge of a test, with its session directory. */
interface Fixture {
	baseUrl: string;
	token: string;
	sessionDir: string;
	close: () => Promise<void>;
}

/** Start the bridge of a test and make a session directory. */
async function startFixture(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-fact-"));
	const sessionDir = join(dir, "session");
	mkdirSync(sessionDir, { recursive: true });
	const bridge = await startBridge("wz-1", () => undefined, sessionDir);
	return {
		baseUrl: bridge.baseUrl,
		token: bridge.token,
		sessionDir,
		close: async () => {
			await bridge.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the mod registers the fact tool of the worker", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const names = mod.tools().map((tool) => tool.name);
		assert.ok(names.includes(PROPOSE_FACT), "the mod registered no fact tool");
	} finally {
		await fixture.close();
	}
});

test("the worker tool proposes a fact that the main session can read", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const handler = mod.toolHandler(PROPOSE_FACT);
		assert.ok(handler, "the mod registers no handler for the fact tool");
		const result = await handler(
			mod.dollar,
			{ key: "build", text: "The build fails on Windows.", tool: PROPOSE_FACT },
			() => undefined,
		);
		assert.equal(toolResult(result).isError, undefined);
		const facts = readProposedFacts(fixture.sessionDir);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.key, "build");
		assert.equal(facts[0]?.text, "The build fails on Windows.");
		assert.equal(facts[0]?.writer, "wz-1");
	} finally {
		await fixture.close();
	}
});

test("the native name of the fact tool reaches the same handler", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const handler = mod.toolHandler(MCP_PROPOSE_FACT);
		assert.ok(handler, "the mod registers no handler for the native name of the fact tool");
		const result = await handler(
			mod.dollar,
			{ key: "path", text: "The state directory holds the facts.", tool: MCP_PROPOSE_FACT },
			() => undefined,
		);
		assert.equal(toolResult(result).isError, undefined);
		const facts = readProposedFacts(fixture.sessionDir);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.key, "path");
	} finally {
		await fixture.close();
	}
});

test("a fact without a text is refused by the bridge", async () => {
	const fixture = await startFixture();
	try {
		const mod = await startMod(fixture, join(fixture.sessionDir, "handover.json"), fixture.sessionDir);
		const handler = mod.toolHandler(PROPOSE_FACT);
		assert.ok(handler);
		const result = await handler(mod.dollar, { key: "build", text: "   " }, () => undefined);
		assert.equal(toolResult(result).isError, true);
		assert.match(toolResult(result).result ?? "", /needs text/);
		assert.equal(readProposedFacts(fixture.sessionDir).length, 0);
	} finally {
		await fixture.close();
	}
});

test("a request for another run proposes no fact", async () => {
	const fixture = await startFixture();
	try {
		const response = await fetch(`${fixture.baseUrl}/facts/propose`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${fixture.token}`,
			},
			body: JSON.stringify({ runId: "wz-2", key: "build", text: "The build fails on Windows." }),
		});
		assert.equal(response.status, 404);
		assert.equal(readProposedFacts(fixture.sessionDir).length, 0);
	} finally {
		await fixture.close();
	}
});

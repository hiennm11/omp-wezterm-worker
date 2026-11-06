import assert from "node:assert/strict";
import { test } from "node:test";

import { handleMessage } from "../extensions/codex-report/report-server.ts";
import { executionsOfRun } from "../extensions/lib/executions.ts";
import { completionBlockerOf } from "../extensions/lib/ledger-sync.ts";
import { recordNativeCall } from "../extensions/lib/native-ledger.ts";
import { freshDb } from "./execution-helpers.ts";

const ENV = {
	WEZTERM_WORKER_URL: "http://bridge.test",
	WEZTERM_WORKER_TOKEN: "test-token-0123456789",
	WEZTERM_WORKER_RUN_ID: "run-1",
};

async function callBackground(args: Record<string, unknown>, observations: unknown[]) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		observations.push(JSON.parse(String(init?.body)));
		return new Response("{}", { status: 202 });
	};
	try {
		return await handleMessage(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "wezterm_worker_background", arguments: args },
			},
			ENV,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("a declared background execution blocks completion until its result is settled", async () => {
	const { db } = freshDb();
	const observations: Array<{ source: string; payload: unknown }> = [];
	try {
		await callBackground({ action: "declare", label: "build" }, observations);
		for (const item of observations) {
			recordNativeCall(db, "run-1", { backend: "codex", runId: "run-1", sessionId: null, ...item }, 1000);
		}
		assert.ok(completionBlockerOf(db, "run-1"));

		await callBackground({ action: "settle", label: "build", status: "completed" }, observations);
		const item = observations.at(-1)!;
		recordNativeCall(db, "run-1", { backend: "codex", runId: "run-1", sessionId: null, ...item }, 2000);
		assert.equal(completionBlockerOf(db, "run-1"), null);
		assert.equal(executionsOfRun(db, "run-1")[0].evidence, "background task completed");
	} finally {
		db.close();
	}
});

test("a repeated background declaration keeps one open execution", async () => {
	const { db } = freshDb();
	const observations: Array<{ source: string; payload: unknown }> = [];
	try {
		await callBackground({ action: "declare", label: "build" }, observations);
		await callBackground({ action: "declare", label: "build" }, observations);
		for (const item of observations) {
			recordNativeCall(db, "run-1", { backend: "codex", runId: "run-1", sessionId: null, ...item }, 1000);
		}
		assert.equal(executionsOfRun(db, "run-1").filter((row) => row.state === "open").length, 1);
	} finally {
		db.close();
	}
});

test("settling an unknown background label does not create an execution", async () => {
	const { db } = freshDb();
	const observations: Array<{ source: string; payload: unknown }> = [];
	try {
		const response = await callBackground(
			{ action: "settle", label: "unknown", status: "failed" },
			observations,
		);
		assert.equal((response?.result as { isError: boolean }).isError, false);
		for (const item of observations) {
			recordNativeCall(db, "run-1", { backend: "codex", runId: "run-1", sessionId: null, ...item }, 1000);
		}
		assert.deepEqual(executionsOfRun(db, "run-1"), []);
	} finally {
		db.close();
	}
});

test("the report server lists the report and background tools", async () => {
	const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
	assert.deepEqual(tools.map((tool) => tool.name), [
		"wezterm_worker_report",
		"wezterm_worker_background",
	]);
});

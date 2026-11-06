import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	type ModDollar,
	type ModHandler,
	type ModMatcher,
	type ModOn,
	register,
} from "../extensions/claude-mod/hooks/register.js";
import { applyObservation, claudeBoundReport } from "../extensions/lib/claude-run-state.ts";
import { restoreRunState } from "../extensions/lib/reattach-native.ts";
import { reportFile } from "../extensions/lib/report-store.ts";
import { cleanup, fakeRuntime, nativeJob } from "./reattach-native-helpers.ts";

const SESSION_DIR = "/sessions/session-1";
const REPORT_FILE = `${SESSION_DIR}/.wezterm-worker-reports-run-1.jsonl`;

type Handler = ModHandler;

interface Fake {
	handler(tool: string): Handler;
	dollar: ModDollar;
	lines: string[];
}

async function startFake(options: { postFails?: boolean; writeFails?: boolean } = {}): Promise<Fake> {
	const handlers = new Map<string, Handler>();
	const lines: string[] = [];
	let sessionStart: Handler | undefined;
	const on: ModOn = (event: string, matcher: ModMatcher | Handler | undefined, handler?: Handler) => {
		if (event === "tool.call" && typeof matcher === "object") {
			handlers.set(matcher.tool ?? "", handler as Handler);
		}
		if (event === "session.start" && typeof matcher === "function") sessionStart = matcher;
	};
	register(on);
	const env: Record<string, string> = {
		WEZTERM_WORKER_URL: "http://127.0.0.1:9999",
		WEZTERM_WORKER_TOKEN: "token-1",
		WEZTERM_WORKER_RUN_ID: "run-1",
		WEZTERM_WORKER_HANDOVER: `${SESSION_DIR}/handover.json`,
	};
	const dollar: ModDollar = {
		env: { get: async (name: string) => env[name] ?? null },
		session: { id: async () => "session-1" },
		fs: {
			read: async () => null,
			write: async (path: string, text: string) => {
				assert.equal(path, REPORT_FILE);
				if (options.writeFails) throw new Error("disk full");
				lines.push(text);
			},
		},
		http: {
			fetch: async () => {
				if (options.postFails) throw new Error("bridge closed");
				return { ok: true, status: 200, text: "{}" };
			},
		},
		tool: { register: async () => undefined },
		clock: { every: async () => undefined },
		prompt: { submit: async () => ({}) },
	};
	assert.ok(sessionStart);
	await sessionStart(dollar, { cwd: SESSION_DIR, isInteractive: true }, () => undefined);
	return {
		handler(tool) {
			const handler = handlers.get(tool);
			assert.ok(handler, `missing handler for ${tool}`);
			return handler;
		},
		dollar,
		lines,
	};
}

function report(): Record<string, string> {
	return { tool_use_id: "call-1", state: "completed", result: "REPORT-SAVED" };
}

function isErrorResult(value: unknown): boolean | undefined {
	if (!value || typeof value !== "object" || !("isError" in value)) return undefined;
	return typeof value.isError === "boolean" ? value.isError : undefined;
}

function resultText(value: unknown): string {
	if (!value || typeof value !== "object" || !("result" in value)) return "";
	return typeof value.result === "string" ? value.result : "";
}

test("a report remains recoverable when its bridge post fails", async () => {
	for (const tool of ["wezterm_worker_report", "mcp__wezterm-worker__wezterm_worker_report"]) {
		const fake = await startFake({ postFails: true });
		const result = await fake.handler(tool)(fake.dollar, report(), () => undefined);
		assert.equal(fake.lines.length, 1);
		const stored = JSON.parse(fake.lines[0].trim());
		assert.equal(stored.runId, "run-1");
		assert.equal(stored.state, "completed");
		assert.equal(stored.result, "REPORT-SAVED");
		assert.equal(typeof stored.at, "number");
		assert.equal(isErrorResult(result), undefined);
	}
});

test("a report returns an error when both file write and bridge post fail", async () => {
	const fake = await startFake({ postFails: true, writeFails: true });
	const result = await fake.handler("wezterm_worker_report")(fake.dollar, report(), () => undefined);
	assert.equal(isErrorResult(result), true);
	assert.match(resultText(result), /report was not saved/i);
});

test("the restored run reads and accepts the report saved during release", async () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-report-restore-"));
	const sessionDir = join(dir, "session");
	const { rt } = fakeRuntime(dir, [7]);
	const fake = await startFake({ postFails: true });
	try {
		mkdirSync(sessionDir, { recursive: true });
		const job = nativeJob(sessionDir, { id: "run-1" });
		rt.jobs.set(job.id, job);
		await fake.handler("wezterm_worker_report")(fake.dollar, report(), () => undefined);
		const saved = JSON.parse(fake.lines[0]);
		saved.cycleId = "turn-123";
		writeFileSync(reportFile(sessionDir, job.id), `${JSON.stringify(saved)}\n`);
		const state = restoreRunState(rt, job);
		assert.equal(state.currentCycleId, null);
		assert.deepEqual(claudeBoundReport(state), {
			cycleId: "turn-123",
			state: "completed",
			result: "REPORT-SAVED",
		});
	} finally {
		await cleanup(rt, dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the restored report does not match after the run observes a new cycle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-report-cycle-"));
	const sessionDir = join(dir, "session");
	const { rt } = fakeRuntime(dir, [7]);
	try {
		mkdirSync(sessionDir, { recursive: true });
		const job = nativeJob(sessionDir, { id: "run-1" });
		rt.jobs.set(job.id, job);
		writeFileSync(
			reportFile(sessionDir, job.id),
			`${JSON.stringify({ runId: "run-1", cycleId: "turn-old", state: "completed", result: "OLD" })}\n`,
		);
		const state = restoreRunState(rt, job);
		applyObservation(state, {
			backend: "claude",
			runId: job.id,
			sessionId: job.nativeSessionId ?? null,
			source: "turn.start",
			payload: { turnId: "turn-new" },
		});
		assert.equal(claudeBoundReport(state), null);
	} finally {
		await cleanup(rt, dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

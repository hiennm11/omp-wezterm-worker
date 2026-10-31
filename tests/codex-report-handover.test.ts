/**
 * The report server of a Codex worker after a restart of OMP.
 *
 * A restart gives the run a new bridge, so the report server must post to
 * the address that the handover file names. The server reads the file on
 * every post, so the next report of the worker follows the new owner.
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handoverFile } from "../extensions/lib/bridge-handover.ts";

/** The path of the report server program. */
const SERVER_PATH = join(import.meta.dirname, "..", "extensions", "codex-report", "report-server.ts");

/** The token that the test uses for the bridge. */
const TOKEN = "test-token-0123456789";

/** One request that the bridge received. */
interface Received {
	authorization: string;
	body: unknown;
}

/** The bridge of a test. It records the requests that it receives. */
interface FakeBridge {
	url: string;
	received: Received[];
	close: () => Promise<void>;
}

/** Start a bridge that records the requests that it receives. */
async function startBridge(): Promise<FakeBridge> {
	const received: Received[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: unknown = raw;
			try {
				body = JSON.parse(raw);
			} catch {
				/* the body stays the raw text */
			}
			received.push({ authorization: request.headers.authorization ?? "", body });
			response.writeHead(202, { "content-type": "application/json" });
			response.end("{}");
		});
	});
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		received,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** The report server program and the way to read its answers. */
interface RunningServer {
	send: (message: Record<string, unknown>) => void;
	next: () => Promise<Record<string, unknown>>;
	stop: () => Promise<void>;
}

/** Start the report server and read the answers of it. */
async function startServer(url: string, sessionDir: string | null): Promise<RunningServer> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WEZTERM_WORKER_URL: url,
		WEZTERM_WORKER_TOKEN: TOKEN,
		WEZTERM_WORKER_RUN_ID: "wz-1",
	};
	if (sessionDir === null) delete env.WEZTERM_WORKER_SESSION_DIR;
	else env.WEZTERM_WORKER_SESSION_DIR = sessionDir;
	const child = spawn(process.execPath, [SERVER_PATH], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	}) as ChildProcessWithoutNullStreams;
	const waiting: Array<(answer: Record<string, unknown>) => void> = [];
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let at = buffer.indexOf("\n");
		while (at >= 0) {
			const line = buffer.slice(0, at).trim();
			buffer = buffer.slice(at + 1);
			if (line) {
				const answer = JSON.parse(line) as Record<string, unknown>;
				waiting.shift()?.(answer);
			}
			at = buffer.indexOf("\n");
		}
	});
	child.stderr.resume();
	return {
		send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
		next: () => {
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiting.push(resolve);
			return promise;
		},
		stop: async () => {
			child.stdin.end();
			child.kill();
			await new Promise((resolve) => setTimeout(resolve, 100));
		},
	};
}

/** Send one report and wait for the answer of the server. */
async function sendReport(server: RunningServer): Promise<Record<string, unknown>> {
	const answer = server.next();
	server.send({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "wezterm_worker_report",
			arguments: { state: "completed", result: "HANDOVER-OK" },
		},
	});
	return answer;
}

test("the report server posts to the address of the handover file", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "wt-handover-server-"));
	const first = await startBridge();
	const second = await startBridge();
	try {
		writeFileSync(handoverFile(sessionDir), JSON.stringify({ url: first.url, token: "first-token" }), "utf8");
		const server = await startServer(second.url, sessionDir);
		try {
			await sendReport(server);
			assert.equal(first.received.length, 1, "the bridge of the handover file got no report");
			assert.equal(second.received.length, 0, "the bridge of the environment got the report");
			assert.equal(first.received[0].authorization, "Bearer first-token");
		} finally {
			await server.stop();
		}
	} finally {
		await first.close();
		await second.close();
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("the report server follows the handover file when it changes", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "wt-handover-server-"));
	const first = await startBridge();
	const second = await startBridge();
	try {
		writeFileSync(handoverFile(sessionDir), JSON.stringify({ url: first.url, token: "first" }), "utf8");
		const server = await startServer(second.url, sessionDir);
		try {
			await sendReport(server);
			writeFileSync(handoverFile(sessionDir), JSON.stringify({ url: second.url, token: "second" }), "utf8");
			await sendReport(server);
			assert.equal(first.received.length, 1, "the old bridge got the second report");
			assert.equal(second.received.length, 1, "the new bridge got no report");
			assert.equal(second.received[0].authorization, "Bearer second");
		} finally {
			await server.stop();
		}
	} finally {
		await first.close();
		await second.close();
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("the report server falls back to the environment without a handover file", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "wt-handover-server-"));
	const bridge = await startBridge();
	try {
		const server = await startServer(bridge.url, sessionDir);
		try {
			await sendReport(server);
			assert.equal(bridge.received.length, 1, "the bridge of the environment got no report");
			assert.equal(bridge.received[0].authorization, `Bearer ${TOKEN}`);
		} finally {
			await server.stop();
		}
	} finally {
		await bridge.close();
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("the report server falls back to the environment with a malformed handover file", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "wt-handover-server-"));
	const bridge = await startBridge();
	try {
		writeFileSync(handoverFile(sessionDir), "{ not json", "utf8");
		const server = await startServer(bridge.url, sessionDir);
		try {
			await sendReport(server);
			assert.equal(bridge.received.length, 1, "the bridge of the environment got no report");
			assert.equal(bridge.received[0].authorization, `Bearer ${TOKEN}`);
		} finally {
			await server.stop();
		}
	} finally {
		await bridge.close();
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

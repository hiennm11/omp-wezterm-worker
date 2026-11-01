/**
 * The report server of a Codex worker.
 *
 * The test starts the real server program. It writes the JSON-RPC messages
 * of the MCP protocol into its input and reads its answers.
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

/** The path of the report server program. */
const SERVER_PATH = join(import.meta.dirname, "..", "extensions", "codex-report", "report-server.ts");

/** The token that the test uses for the bridge. */
const TOKEN = "test-token-0123456789";

/** One request that the bridge received. */
interface Received {
	path: string;
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
async function startBridge(answer: number): Promise<FakeBridge> {
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
			received.push({
				path: request.url ?? "",
				authorization: request.headers.authorization ?? "",
				body,
			});
			response.writeHead(answer, { "content-type": "application/json" });
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
	child: ChildProcessWithoutNullStreams;
	send: (message: Record<string, unknown>) => void;
	/** The answer of the next request of the client. */
	next: () => Promise<Record<string, unknown>>;
	stop: () => Promise<void>;
}

/** Start the report server and read the answers of it. */
async function startServer(url: string, runId: string): Promise<RunningServer> {
	const child = spawn(process.execPath, [SERVER_PATH], {
		env: {
			...process.env,
			WEZTERM_WORKER_URL: url,
			WEZTERM_WORKER_TOKEN: TOKEN,
			WEZTERM_WORKER_RUN_ID: runId,
		},
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
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	/* A server that ends without an answer must fail the test at once. */
	child.on("exit", () => {
		while (waiting.length > 0) {
			waiting.shift()?.({
				jsonrpc: "2.0",
				id: null,
				error: { code: -1, message: `the report server ended: ${stderr.trim()}` },
			});
		}
	});
	return {
		child,
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

test("the server names the report tool in its tool list", async () => {
	const bridge = await startBridge(202);
	const server = await startServer(bridge.url, "wz-1");
	try {
		const answer = server.next();
		server.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const result = (await answer).result as { tools: Array<{ name: string }> };
		assert.equal(result.tools[0].name, "wezterm_worker_report");
	} finally {
		await server.stop();
		await bridge.close();
	}
});

test("the server rejects a completed report without a result", async () => {
	const bridge = await startBridge(202);
	const server = await startServer(bridge.url, "wz-1");
	try {
		const answer = server.next();
		server.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "wezterm_worker_report", arguments: { state: "completed" } },
		});
		const result = (await answer).result as { isError: boolean; content: Array<{ text: string }> };
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /result/);
		assert.equal(bridge.received.length, 0, "the bridge received an invalid report");
	} finally {
		await server.stop();
		await bridge.close();
	}
});

test("the server posts a valid report to the bridge", async () => {
	const bridge = await startBridge(202);
	const server = await startServer(bridge.url, "wz-7");
	try {
		const answer = server.next();
		server.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "wezterm_worker_report",
				arguments: { state: "completed", result: "SMOKE-OK" },
			},
		});
		const result = (await answer).result as { isError: boolean };
		assert.equal(result.isError, false);
		assert.equal(bridge.received.length, 1, "the bridge received no report");
		const received = bridge.received[0];
		assert.equal(received.path, "/observations");
		assert.equal(received.authorization, `Bearer ${TOKEN}`);
		assert.deepEqual(received.body, {
			backend: "codex",
			runId: "wz-7",
			source: "report",
			payload: { state: "completed", result: "SMOKE-OK", cycleId: null },
		});
	} finally {
		await server.stop();
		await bridge.close();
	}
});

test("the server answers an error when the post fails", async () => {
	const bridge = await startBridge(500);
	const server = await startServer(bridge.url, "wz-1");
	try {
		const answer = server.next();
		server.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "wezterm_worker_report",
				arguments: { state: "completed", result: "SMOKE-OK" },
			},
		});
		const error = (await answer).error as { code: number; message: string } | undefined;
		assert.ok(error, "the server answered without an error");
		assert.equal(typeof error.code, "number");
		assert.match(error.message, /did not record the report/);
	} finally {
		await server.stop();
		await bridge.close();
	}
});

test("the server refuses a tool that it does not hold", async () => {
	const bridge = await startBridge(202);
	const server = await startServer(bridge.url, "wz-1");
	try {
		const answer = server.next();
		server.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "another_tool", arguments: { state: "completed", result: "x" } },
		});
		const error = (await answer).error as { message: string } | undefined;
		assert.ok(error, "the server answered without an error");
		assert.match(error.message, /unknown tool/);
	} finally {
		await server.stop();
		await bridge.close();
	}
});

test("the server sends the turn id of the call as the cycle id", async () => {
	const bridge = await startBridge(202);
	const server = await startServer(bridge.url, "wz-9");
	try {
		const answer = server.next();
		server.send({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				_meta: {
					callId: "exec-1b72adc9",
					"x-codex-turn-metadata": {
						session_id: "01a197ba-5e5b",
						thread_id: "01a197ba-5e5b",
						turn_id: "01a197ba-7450-7473-ba85-a8a45ed8c122",
						model: "gpt-6-luna",
						codex_version: "0.166.0",
					},
					threadId: "01a197ba-5e5b",
					sessionId: "01a197ba-5e5b",
					itemId: "ctc_098e8a87",
				},
				name: "wezterm_worker_report",
				arguments: { state: "completed", result: "SMOKE-OK" },
			},
		});
		const result = (await answer).result as { isError: boolean };
		assert.equal(result.isError, false);
		const body = bridge.received[0].body as { payload: { cycleId: string } };
		assert.equal(body.payload.cycleId, "01a197ba-7450-7473-ba85-a8a45ed8c122");
	} finally {
		await server.stop();
		await bridge.close();
	}
});

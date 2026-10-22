/**
 * The Codex proof client.
 *
 * The client connects to one dedicated app server over a loopback WebSocket.
 * It never answers a permission request. The real TUI owns the answer.
 */

import { spawn } from "node:child_process";

/** One message of the app-server protocol. */
export interface ProtocolMessage {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

/** The client of one app server. */
export interface AppServerClient {
	/** The WebSocket of the client. */
	socket: WebSocket;
	/** The thread that the client started. */
	threadId: string | null;
	/** The messages that the server sent. */
	messages: ProtocolMessage[];
	/** Send one request and wait for its response. */
	request: (method: string, params?: Record<string, unknown>) => Promise<ProtocolMessage>;
	/** Send one notification. */
	notify: (method: string, params?: Record<string, unknown>) => void;
	/** Close the client. */
	close: () => void;
}

/** The client name that the proof uses. */
export const PROOF_CLIENT_NAME = "wezterm_worker_proof";

/**
 * Connect to one app server.
 *
 * The client sends the initialize request with the experimental capability,
 * because the proof uses the experimental queue contract.
 */
export async function connectAppServer(
	endpoint: string,
	onMessage: (message: ProtocolMessage) => void = () => undefined,
): Promise<AppServerClient> {
	const socket = new WebSocket(endpoint);
	const messages: ProtocolMessage[] = [];
	const waiters = new Map<number, (message: ProtocolMessage) => void>();
	let nextId = 1;
	let threadId: string | null = null;

	const { promise: opened, resolve: resolveOpened, reject: rejectOpened } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => resolveOpened());
	socket.addEventListener("error", (event) =>
		rejectOpened(new Error(`the app server connection failed: ${String(event.type)}`)),
	);
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as ProtocolMessage;
		messages.push(message);
		if (typeof message.id === "number") {
			const waiter = waiters.get(message.id);
			if (waiter) {
				waiters.delete(message.id);
				waiter(message);
			}
		}
		onMessage(message);
	});
	await opened;

	const request = (method: string, params: Record<string, unknown> = {}): Promise<ProtocolMessage> => {
		const id = nextId;
		nextId += 1;
		const { promise, resolve } = Promise.withResolvers<ProtocolMessage>();
		waiters.set(id, resolve);
		socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise;
	};

	const notify = (method: string, params: Record<string, unknown> = {}) => {
		socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	};

	const initialize = await request("initialize", {
		clientInfo: { name: PROOF_CLIENT_NAME, title: "OMP worker proof", version: "0.1.0" },
		capabilities: { experimentalApi: true },
	});
	if (initialize.error) {
		throw new Error(`the app server refused the initialization: ${initialize.error.message}`);
	}
	notify("initialized", {});

	return {
		socket,
		get threadId() {
			return threadId;
		},
		set threadId(value: string | null) {
			threadId = value;
		},
		messages,
		request,
		notify,
		close: () => socket.close(),
	};
}

/**
 * Start one dedicated app server in a proof-owned pane.
 *
 * The server runs with the working directory of the fixture. It uses the
 * per-invocation configuration overrides that the installed schema allows.
 */
export function startAppServer(options: {
	bin: string;
	port: number;
	cwd: string;
	reportServer: string;
	env: Record<string, string>;
}): { paneId: number | null; error: string | null; args: string[] } {
	const args = [
		"app-server",
		"--listen",
		`ws://127.0.0.1:${options.port}`,
		"-c",
		`mcp_servers.wezterm_worker_proof.command="node"`,
		"-c",
		`mcp_servers.wezterm_worker_proof.args=["${options.reportServer.replace(/\\/g, "/")}"]`,
	];
	const child = spawn(options.bin, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdout.resume();
	child.stderr.resume();
	return { paneId: null, error: null, args };
}

/** The endpoint of one app server. */
export function endpointFor(port: number): string {
	return `ws://127.0.0.1:${port}`;
}

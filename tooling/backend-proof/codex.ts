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

/** One observation of a protocol message. */
export interface ProtocolObservation {
	/** The source of the observation. */
	source: string;
	/** The payload of the observation. */
	payload: unknown;
}

/**
 * Map one protocol message to the pair of an observation.
 *
 * A notification and a request give the source of their method. A response
 * gives the source of a response and keeps its id. A message without a method
 * and without an id gives the unknown source.
 */
export function observationOf(message: ProtocolMessage): ProtocolObservation {
	if (message.method) {
		return { source: `codex.${message.method}`, payload: message.params ?? {} };
	}
	if (message.id !== undefined) {
		const payload: Record<string, unknown> = { id: message.id };
		if (message.result !== undefined) payload.result = message.result;
		if (message.error !== undefined) payload.error = message.error;
		return { source: "codex.response", payload };
	}
	return { source: "codex.unknown", payload: {} };
}

/** The names of the fields that hold a secret. */
const SECRET_NAMES = ["token", "apikey", "secret", "password", "authorization", "credential"];

/**
 * The names of the fields of a payload that hold a secret.
 *
 * The proof sends no secret. The function names a field that would.
 */
export function secretFields(payload: unknown, prefix = ""): string[] {
	if (Array.isArray(payload)) {
		return payload.flatMap((item, index) => secretFields(item, `${prefix}[${index}]`));
	}
	if (payload === null || typeof payload !== "object") return [];
	const found: string[] = [];
	for (const [key, value] of Object.entries(payload)) {
		const name = prefix ? `${prefix}.${key}` : key;
		const lower = key.toLowerCase();
		if (SECRET_NAMES.some((secret) => lower === secret || lower.endsWith(secret))) {
			found.push(name);
			continue;
		}
		found.push(...secretFields(value, name));
	}
	return found;
}

/** The client of one app server. */
export interface AppServerClient {
	/** The WebSocket of the client. */
	socket: WebSocket;
	/** The thread that the client started. */
	threadId: string | null;
	/** The messages that the server sent. */
	messages: ProtocolMessage[];
	/** The messages that the client sent. */
	sent: ProtocolMessage[];
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
 * The parameters of the initialize request.
 *
 * The request carries no token. The proof reads the credentials of the
 * machine from the environment of the app server, not from this request.
 */
export function initializeParams(): Record<string, unknown> {
	return {
		clientInfo: { name: PROOF_CLIENT_NAME, title: "OMP worker proof", version: "0.1.0" },
		capabilities: { experimentalApi: true },
	};
}

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
	const sent: ProtocolMessage[] = [];
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
		sent.push({ id, method, params });
		socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise;
	};

	const notify = (method: string, params: Record<string, unknown> = {}) => {
		sent.push({ method, params });
		socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	};

	const initialize = await request("initialize", initializeParams());
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
		sent,
		request,
		notify,
		close: () => socket.close(),
	};
}

/**
 * Build the configuration options that load the report server.
 *
 * The app server does not pass its own environment to a stdio MCP server.
 * The option `env_vars` names the variables that the child inherits from the
 * app server. The option `env` would put the token value into the command
 * line of the process, and every process of the user can read that line.
 */
export function reportServerArgs(path: string): string[] {
	const serverPath = path.replace(/\\/g, "/");
	return [
		"-c",
		'mcp_servers.wezterm_worker_proof.command="node"',
		"-c",
		`mcp_servers.wezterm_worker_proof.args=["${serverPath}"]`,
		"-c",
		'mcp_servers.wezterm_worker_proof.env_vars=["WEZTERM_PROOF_URL","WEZTERM_PROOF_TOKEN","WEZTERM_PROOF_RUN_ID"]',
	];
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
		...reportServerArgs(options.reportServer),
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

/**
 * The client of one Codex app server.
 *
 * The client speaks the protocol of the app server over a loopback
 * WebSocket. It never answers a permission request. The real TUI owns that
 * answer.
 */

/** One message of the app-server protocol. */
export interface CodexProtocolMessage {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

/** The client of one app server. */
export interface CodexClient {
	/** Send one request and wait for its answer. */
	request: (method: string, params?: Record<string, unknown>) => Promise<CodexProtocolMessage>;
	/** Send one notification. */
	notify: (method: string, params?: Record<string, unknown>) => void;
	/** Close the connection. */
	close: () => void;
	/**
	 * Set the handler of the messages that are not the answer of a request.
	 *
	 * The client never answers a request of the server. The real TUI owns
	 * that answer.
	 */
	setMessageHandler: (handler: (message: CodexProtocolMessage) => void) => void;
}

/** The client name that the extension uses. */
export const CODEX_CLIENT_NAME = "omp_wezterm_worker";

/** How long a request waits for its answer. */
export const CODEX_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The parameters of the initialize request.
 *
 * The request carries the capability `experimentalApi`, because the extension
 * uses the experimental contract of the app server.
 */
export function initializeParams(): Record<string, unknown> {
	return {
		clientInfo: { name: CODEX_CLIENT_NAME, title: "OMP worker", version: "0.1.0" },
		capabilities: { experimentalApi: true },
	};
}

/**
 * Connect to one app server.
 *
 * The client sends the initialize request and then the notification
 * `initialized`. A request that holds no answer after twenty seconds
 * rejects, so a server that stops answering cannot hold the launch.
 */
export async function connectCodexServer(
	endpoint: string,
	timeoutMs: number = CODEX_REQUEST_TIMEOUT_MS,
): Promise<CodexClient> {
	const socket = new WebSocket(endpoint);
	const waiters = new Map<number, (message: CodexProtocolMessage) => void>();
	let nextId = 1;
	let handler: (message: CodexProtocolMessage) => void = () => undefined;

	const { promise: opened, resolve: resolveOpened, reject: rejectOpened } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => resolveOpened());
	socket.addEventListener("error", (event) =>
		rejectOpened(new Error(`the app server connection failed: ${String(event.type)}`)),
	);
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as CodexProtocolMessage;
		/* A message that names a method is a notification or a request of
		   the server. The handler reads it. The client never answers it,
		   because the real TUI owns that answer. */
		if (typeof message.method === "string" && message.method.length > 0) {
			handler(message);
			return;
		}
		if (typeof message.id !== "number") {
			handler(message);
			return;
		}
		const waiter = waiters.get(message.id);
		if (!waiter) {
			handler(message);
			return;
		}
		waiters.delete(message.id);
		waiter(message);
	});
	await opened;

	const request = (method: string, params: Record<string, unknown> = {}): Promise<CodexProtocolMessage> => {
		const id = nextId;
		nextId += 1;
		const { promise, resolve, reject } = Promise.withResolvers<CodexProtocolMessage>();
		const timer = setTimeout(() => {
			waiters.delete(id);
			reject(new Error(`the app server gave no answer to '${method}' after ${timeoutMs} ms`));
		}, timeoutMs);
		timer.unref?.();
		waiters.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise;
	};

	const notify = (method: string, params: Record<string, unknown> = {}) => {
		socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	};

	const initialize = await request("initialize", initializeParams());
	if (initialize.error) {
		socket.close();
		throw new Error(`the app server refused the initialization: ${initialize.error.message}`);
	}
	notify("initialized", {});

	return {
		request,
		notify,
		close: () => socket.close(),
		setMessageHandler: (next: (message: CodexProtocolMessage) => void) => {
			handler = next;
		},
	};
}

/**
 * The id of the thread that the answer of `thread/start` names.
 *
 * The answer holds the thread under `thread.id`. An answer without that
 * field gives null, so the caller refuses the launch.
 */
export function threadIdOf(message: CodexProtocolMessage): string | null {
	const result = message.result as { thread?: { id?: unknown } } | undefined;
	const id = result?.thread?.id;
	return typeof id === "string" && id ? id : null;
}

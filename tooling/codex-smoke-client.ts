/**
 * The client of one app server of Codex for the smoke test.
 *
 * The client speaks the protocol of the app server over a loopback
 * WebSocket. It reads the events of a thread, so the smoke test can record
 * the time of each event. It never answers a permission request, because the
 * TUI of the user owns that answer.
 */

/** One message of the protocol of the app server. */
export interface ProtocolMessage {
	/** The id of a request or of its answer. */
	id?: number;
	/** The name of a method of a notification or of a request. */
	method?: string;
	/** The parameters of a notification or of a request. */
	params?: Record<string, unknown>;
	/** The result of a request. */
	result?: unknown;
	/** The error of a request. */
	error?: { code: number; message: string };
}

/** The client of one app server. */
export interface AppServerClient {
	/** The messages that the server sent. */
	messages: ProtocolMessage[];
	/** Send one request and wait for its answer. */
	request: (method: string, params?: Record<string, unknown>) => Promise<ProtocolMessage>;
	/** Close the connection. */
	close: () => void;
}

/**
 * Connect to one app server.
 *
 * The client sends the request `initialize` with the experimental capability
 * of the protocol, and then the notification `initialized`.
 */
export async function connectAppServer(endpoint: string): Promise<AppServerClient> {
	const socket = new WebSocket(endpoint);
	const messages: ProtocolMessage[] = [];
	const waiters = new Map<number, (message: ProtocolMessage) => void>();
	let nextId = 1;
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve());
	socket.addEventListener("error", () => opened.reject(new Error("the app server connection failed")));
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as ProtocolMessage;
		messages.push(message);
		if (typeof message.id !== "number") return;
		const waiter = waiters.get(message.id);
		if (!waiter) return;
		waiters.delete(message.id);
		waiter(message);
	});
	await opened.promise;

	const request = (method: string, params: Record<string, unknown> = {}): Promise<ProtocolMessage> => {
		const id = nextId;
		nextId += 1;
		const { promise, resolve } = Promise.withResolvers<ProtocolMessage>();
		waiters.set(id, resolve);
		socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise;
	};

	const initialize = await request("initialize", {
		clientInfo: { name: "omp_codex_smoke", title: "OMP Codex smoke", version: "0.1.0" },
		capabilities: { experimentalApi: true },
	});
	if (initialize.error) {
		socket.close();
		throw new Error(`the app server refused the initialization: ${initialize.error.message}`);
	}
	socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));

	return { messages, request, close: () => socket.close() };
}

/** The id of the turn that a message of `turn/started` names. */
export function turnIdOf(message: ProtocolMessage): string | null {
	const turn = message.params?.turn as { id?: unknown } | undefined;
	return typeof turn?.id === "string" ? turn.id : null;
}

/** The item that a message of `item/started` carries. */
export function itemOf(message: ProtocolMessage): {
	type?: string;
	clientId?: string | null;
	text?: string;
} | null {
	const item = message.params?.item as
		| { type?: unknown; clientId?: unknown; content?: Array<{ text?: unknown }> }
		| undefined;
	if (!item || typeof item.type !== "string") return null;
	const first = item.content?.[0];
	return {
		type: item.type,
		clientId: typeof item.clientId === "string" ? item.clientId : null,
		text: typeof first?.text === "string" ? first.text : undefined,
	};
}

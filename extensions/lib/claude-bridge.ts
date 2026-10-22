/**
 * The bridge between a Claude Code worker and the main session.
 *
 * The worker mod talks to this server over the loopback interface. The server
 * holds the observations of one run and hands out the commands of the owner.
 *
 * The server binds only to 127.0.0.1 and requires a bearer token. The token
 * is random and it reaches the worker through the environment of the launch.
 * The server never writes to the state of another run.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One observation that a worker sent. */
export interface BridgeObservation {
	backend: string;
	runId: string | null;
	sessionId: string | null;
	source: string;
	payload: unknown;
}

/** One command that the owner wants the worker to run. */
export interface BridgeCommand {
	id: string;
	runId: string;
	text: string;
}

/** The result of one command. */
export interface BridgeCommandResult {
	id: string;
	phase: "received" | "accepted" | "delivered" | "refused";
	nativeId: string | null;
	error: string | null;
}

/** The state that the bridge holds for one run. */
export interface BridgeState {
	/** The token that every request must carry. */
	token: string;
	/** The address that the worker must call. */
	baseUrl: string;
	/** The observations that the worker sent, in the order they arrived. */
	observations: BridgeObservation[];
	/** The commands that the owner queued. */
	commands: BridgeCommand[];
	/** The results of the commands, by command id. */
	results: Map<string, BridgeCommandResult>;
	/** Close the server. */
	close: () => Promise<void>;
	/** The port that the server bound. */
	port: number;
}

/** The handler that the bridge calls for every observation. */
export type ObservationHandler = (observation: BridgeObservation) => void;

/**
 * Start the bridge of one run.
 *
 * The server takes the observations through the handler. The handler decides
 * what happens with them, so the bridge stays a transport.
 */
export async function startBridge(runId: string, onObservation: ObservationHandler): Promise<BridgeState> {
	const token = randomBytes(24).toString("hex");
	const observations: BridgeObservation[] = [];
	const commands: BridgeCommand[] = [];
	const results = new Map<string, BridgeCommandResult>();
	let closed = false;

	const server: Server = createServer((request, response) => {
		void handle(request, response);
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		/* A closed bridge belongs to a run that ended. A native process
		   that still polls it must stop, so it never sends an observation
		   to another run. */
		if (closed) {
			send(response, 410, { error: "the run has ended" });
			return;
		}
		if (!authorized(request)) {
			send(response, 401, { error: "unauthorized" });
			return;
		}
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "POST" && url.pathname === "/observations") {
			const body = await readBody(request);
			if (!body) {
				send(response, 400, { error: "invalid json" });
				return;
			}
			const observation = body as Partial<BridgeObservation>;
			const full: BridgeObservation = {
				backend: observation.backend ?? "claude",
				runId: observation.runId ?? null,
				sessionId: observation.sessionId ?? null,
				source: observation.source ?? "unknown",
				payload: observation.payload ?? null,
			};
			observations.push(full);
			onObservation(full);
			send(response, 202, { recorded: true });
			return;
		}
		if (request.method === "POST" && url.pathname === "/command-results") {
			const body = await readBody(request);
			if (!body) {
				send(response, 400, { error: "invalid json" });
				return;
			}
			const result = body as Partial<BridgeCommandResult>;
			if (typeof result.id !== "string") {
				send(response, 400, { error: "invalid json" });
				return;
			}
			results.set(result.id, {
				id: result.id,
				phase: result.phase ?? "received",
				nativeId: result.nativeId ?? null,
				error: result.error ?? null,
			});
			send(response, 202, { recorded: true });
			return;
		}
		if (request.method === "GET" && url.pathname === "/commands") {
			const wanted = url.searchParams.get("runId");
			/* A request for another run never finds a command. The bridge
			   holds the commands of one run only. */
			const command = wanted === runId ? commands.find((item) => !results.has(item.id)) : undefined;
			send(response, 200, { command: command ?? null });
			return;
		}
		send(response, 404, { error: "not found" });
	}

	function authorized(request: IncomingMessage): boolean {
		const header = request.headers.authorization ?? "";
		return header === `Bearer ${token}`;
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		token,
		baseUrl: `http://127.0.0.1:${port}`,
		observations,
		commands,
		results,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				closed = true;
				server.close(() => resolve());
			}),
	};
}

/** Read the body of a request as JSON, or null when it is not JSON. */
async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Send a JSON response. */
function send(response: ServerResponse, code: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(code, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text),
	});
	response.end(text);
}

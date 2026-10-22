/**
 * The authenticated loopback listener of the proof.
 *
 * A native program sends its observations to this listener. The proof runner
 * sends its commands to the same listener. Every request carries a bearer
 * token that the runner generates for one run.
 *
 * The listener binds only to 127.0.0.1 on a port that the operating system
 * assigns. It never writes a credential to a file.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One command that the runner sends to a native program. */
export interface ProofCommand {
	/** The id of the command. */
	id: string;
	/** The proof run that owns the command. */
	runId: string;
	/** The text of the instruction. */
	text: string;
}

/** The phase that a native program reached with one command. */
export type CommandPhase = "received" | "accepted" | "delivered" | "refused";

/** The result of one command. */
export interface CommandResult {
	/** The id of the command that the result belongs to. */
	id: string;
	/** The phase that the native program reached. */
	phase: CommandPhase;
	/** The native id of the instruction, when the program knows it. */
	nativeId: string | null;
	/** The reason of a refusal, when the program refused. */
	error: string | null;
}

/** The listener of one proof run. */
export interface ProofListener {
	/** The port that the listener bound. */
	port: number;
	/** The token that every request must carry. */
	token: string;
	/** The base URL of the listener. */
	baseUrl: string;
	/** The commands that no native program has taken yet. */
	pending: () => ProofCommand[];
	/** The results that the native programs reported. */
	results: () => CommandResult[];
	/** Take one command for a run. */
	take: (runId: string) => ProofCommand | null;
	/** Record the result of one command. */
	record: (result: CommandResult) => void;
	/** Close the listener. */
	close: () => Promise<void>;
	/** The state of the listener, so a recovery can restore it. */
	state: () => ListenerState;
}

/** The state that a recovery restores. */
export interface ListenerState {
	/** The port that the listener bound. */
	port: number;
	/** The token that every request must carry. */
	token: string;
	/** The commands that the listener holds. */
	commands: ProofCommand[];
	/** The results that the listener holds. */
	results: CommandResult[];
}

/** The body of a request, read as text. */
async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** Answer a request with JSON. */
function sendJson(response: ServerResponse, code: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(code, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text),
	});
	response.end(text);
}

/** The phases that the listener accepts. */
const PHASES: CommandPhase[] = ["received", "accepted", "delivered", "refused"];

/**
 * Bind the listener to a port.
 *
 * A recovery binds the same port again. The old socket can still hold it for
 * a moment, so the bind is tried again.
 */
async function listenWithRetry(server: Server, port: number): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resolve();
		});
		try {
			await promise;
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	throw new Error(`the listener could not bind the port ${port}`);
}

/**
 * Start the listener of one proof run.
 *
 * The token is a random value. Only the runner and the native program know it.
 * Every observation that a native program sends reaches the callback.
 */
export async function startListener(
	onObservation: (payload: unknown) => void = () => undefined,
	restore?: ListenerState,
): Promise<ProofListener> {
	const token = restore?.token ?? randomBytes(24).toString("hex");
	const commands: ProofCommand[] = [...(restore?.commands ?? [])];
	const results: CommandResult[] = [...(restore?.results ?? [])];
	const taken = new Set<string>();

	const server: Server = createServer((request, response) => {
		void (async () => {
			const header = request.headers.authorization ?? "";
			if (header !== `Bearer ${token}`) {
				sendJson(response, 401, { error: "unauthorized" });
				return;
			}
			const url = request.url ?? "";
			const path = url.split("?")[0];

			if (request.method === "POST" && path === "/observations") {
				const body = await readBody(request);
				let parsed: unknown;
				try {
					parsed = JSON.parse(body);
				} catch {
					sendJson(response, 400, { error: "invalid json" });
					return;
				}
				onObservation(parsed);
				sendJson(response, 202, { recorded: true });
				return;
			}

			if (request.method === "POST" && path === "/commands") {
				const body = await readBody(request);
				let parsed: ProofCommand;
				try {
					parsed = JSON.parse(body) as ProofCommand;
				} catch {
					sendJson(response, 400, { error: "invalid json" });
					return;
				}
				if (!parsed.id || !parsed.runId || typeof parsed.text !== "string") {
					sendJson(response, 400, { error: "a command needs an id, a run id and a text" });
					return;
				}
				commands.push(parsed);
				sendJson(response, 202, { recorded: true });
				return;
			}

			if (request.method === "GET" && path === "/commands") {
				const runId = new URL(url, "http://127.0.0.1").searchParams.get("runId") ?? "";
				const next = commands.find((c) => c.runId === runId && !taken.has(c.id));
				if (!next) {
					sendJson(response, 200, { command: null });
					return;
				}
				taken.add(next.id);
				sendJson(response, 200, { command: next });
				return;
			}

			if (request.method === "POST" && path === "/command-results") {
				const body = await readBody(request);
				let parsed: CommandResult;
				try {
					parsed = JSON.parse(body) as CommandResult;
				} catch {
					sendJson(response, 400, { error: "invalid json" });
					return;
				}
				if (!PHASES.includes(parsed.phase)) {
					sendJson(response, 400, { error: `unknown phase ${String(parsed.phase)}` });
					return;
				}
				results.push({
					id: parsed.id,
					phase: parsed.phase,
					nativeId: parsed.nativeId ?? null,
					error: parsed.error ?? null,
				});
				sendJson(response, 202, { recorded: true });
				return;
			}

			sendJson(response, 404, { error: "not found" });
		})();
	});

	/* A recovery binds the same port again. The socket must accept it. */
	server.on("error", () => undefined);
	await listenWithRetry(server, restore?.port ?? 0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		port,
		token,
		baseUrl: `http://127.0.0.1:${port}`,
		pending: () => commands.filter((c) => !taken.has(c.id)),
		results: () => results.map((r) => ({ ...r })),
		take(runId) {
			const next = commands.find((c) => c.runId === runId && !taken.has(c.id));
			if (!next) return null;
			taken.add(next.id);
			return next;
		},
		record(result) {
			results.push(result);
		},
		state: () => ({
			port,
			token,
			commands: commands.map((c) => ({ ...c })),
			results: results.map((r) => ({ ...r })),
		}),
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
	};
}

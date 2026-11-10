/**
 * The layout of Herdr.
 *
 * Herdr 0.9.5 has no `layout` command in its CLI. The method `layout.apply`
 * exists in the socket API only, so this module speaks that protocol.
 *
 * The call creates a fresh tab from a declarative tree. The call never names
 * a `tab_id`, because a `tab_id` replaces the panes of that tab, and the tab
 * of the main session must survive.
 *
 * A leaf of type `pane` holds the `command` as an array. Every element stays
 * one argv element, so a program with spaces, quotes and `$(...)` keeps its
 * shape.
 *
 * The seam of the runtime carries the request, so a test replaces it and
 * needs no Herdr server.
 */

import net from "node:net";

import type { RunResult } from "./process.ts";

/** The variable that holds the path of the socket of the session. */
const SOCKET_PATH_VAR = "HERDR_SOCKET_PATH";

/** How long the client waits for the reply of the server. */
const REPLY_TIMEOUT_MS = 15_000;

/** The verb that carries a layout request through the seam of the runtime. */
export const LAYOUT_APPLY_VERB = "layout:apply";

/**
 * The path of the socket of the session, or null when the process runs
 * outside a Herdr session.
 */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
	const path = env[SOCKET_PATH_VAR];
	return path === undefined || path === "" ? null : path;
}

/**
 * The name of the pipe of Herdr on Windows.
 *
 * Herdr writes the path of its socket into a file. On Windows that path is
 * the name of a named pipe.
 */
function pipeName(socketPath: string): string {
	if (process.platform !== "win32") return socketPath;
	return `\\\\.\\pipe\\${socketPath}`;
}

/**
 * Send one request to the server of Herdr and read its reply.
 *
 * The protocol is newline-delimited JSON. The server answers one request per
 * connection, so the client opens one connection for one call.
 */
function send(socketPath: string, request: unknown): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const socket = net.connect(pipeName(socketPath));
	let buffer = "";
	const finish = (error: Error | null, value: string): void => {
		socket.destroy();
		if (error) reject(error);
		else resolve(value);
	};
	socket.setTimeout(REPLY_TIMEOUT_MS, () => {
		finish(new Error("the Herdr server did not answer in time."), "");
	});
	socket.on("connect", () => {
		socket.write(`${JSON.stringify(request)}\n`);
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		finish(null, buffer.slice(0, end));
	});
	socket.on("error", (e: Error) => finish(e, ""));
	return promise;
}

/**
 * A member of a parsed reply, or null when it is not there.
 *
 * The reply comes from a program, so the shape is unknown. The function
 * narrows the value instead of trusting it.
 */
export function memberOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return null;
	if (!(key in value)) return null;
	return (value as Record<string, unknown>)[key];
}

/**
 * Run a layout request against the server of Herdr.
 *
 * The parameters hold the tree of the layout. The function returns the
 * answer of the server in the shape of a program answer, so the seam of the
 * runtime stays the same for every verb.
 */
export async function runLayoutApply(params: string): Promise<RunResult> {
	const socketPath = herdrSocketPath();
	if (socketPath === null) {
		return { code: 1, stdout: "", stderr: "The process runs outside a Herdr session." };
	}
	let request: unknown;
	try {
		request = JSON.parse(params);
	} catch {
		return { code: 1, stdout: "", stderr: "The layout request is not JSON." };
	}
	const stdout = await send(socketPath, {
		id: "omp:layout:apply",
		method: "layout.apply",
		params: request,
	});
	if (stdout === "") return { code: 1, stdout: "", stderr: "The Herdr server did not answer." };
	return { code: 0, stdout, stderr: "" };
}

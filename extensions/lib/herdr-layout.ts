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
 */

import net from "node:net";

/** The variable that holds the path of the socket of the session. */
const SOCKET_PATH_VAR = "HERDR_SOCKET_PATH";

/** How long the client waits for the reply of the server. */
const REPLY_TIMEOUT_MS = 15_000;

/** A pane of a layout. */
export interface LayoutPane {
	/** The id of the pane, like `w4:p1`. */
	paneId: string;
	/** The id of the tab of the pane, like `w4:t1`. */
	tabId: string;
	/** The id of the workspace of the pane. */
	workspaceId: string;
}

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
function send(socketPath: string, request: unknown): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const socket = net.connect(pipeName(socketPath));
	let buffer = "";
	const finish = (error: Error | null, value: unknown): void => {
		socket.destroy();
		if (error) reject(error);
		else resolve(value);
	};
	socket.setTimeout(REPLY_TIMEOUT_MS, () => {
		finish(new Error("the Herdr server did not answer in time."), null);
	});
	socket.on("connect", () => {
		socket.write(`${JSON.stringify(request)}\n`);
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		try {
			finish(null, JSON.parse(buffer.slice(0, end)));
		} catch (e) {
			finish(e instanceof Error ? e : new Error(String(e)), null);
		}
	});
	socket.on("error", (e: Error) => finish(e, null));
	return promise;
}

/**
 * A member of a parsed reply, or null when it is not there.
 *
 * The reply comes from a program, so the shape is unknown. The function
 * narrows the value instead of trusting it.
 */
function memberOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return null;
	if (!(key in value)) return null;
	return (value as Record<string, unknown>)[key];
}

/**
 * Open a new tab with one pane that runs a program.
 *
 * The function returns the pane, or null when the server refused the call.
 * The call never names a `tab_id`, so the tab of the main session stays.
 */
export async function applyPaneLayout(options: {
	/** The working directory of the pane. */
	cwd: string;
	/** The program and its arguments. Every element stays one argv element. */
	command: string[];
	/** The environment of the program. */
	env?: NodeJS.ProcessEnv;
	/** The label of the tab. */
	label?: string;
}): Promise<LayoutPane | null> {
	const socketPath = herdrSocketPath();
	if (socketPath === null) return null;
	const leaf: Record<string, unknown> = {
		type: "pane",
		cwd: options.cwd,
		command: options.command,
	};
	if (options.env) {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.env)) {
			if (value === undefined) continue;
			env[key] = value;
		}
		if (Object.keys(env).length > 0) leaf.env = env;
	}
	const params: Record<string, unknown> = { root: leaf, focus: false };
	if (options.label) params.tab_label = options.label;
	const reply = await send(socketPath, { id: "omp:layout:apply", method: "layout.apply", params });
	if (memberOf(reply, "error") !== null) return null;
	const result = memberOf(reply, "result");
	if (result === null) return null;
	const layout = memberOf(result, "layout");
	if (layout === null) return null;
	const root = memberOf(layout, "root");
	if (root === null) return null;
	const paneId = memberOf(root, "pane_id");
	const tabId = memberOf(root, "tab_id");
	const workspaceId = memberOf(layout, "workspace_id");
	if (typeof paneId !== "string") return null;
	return {
		paneId,
		tabId: typeof tabId === "string" ? tabId : "",
		workspaceId: typeof workspaceId === "string" ? workspaceId : "",
	};
}

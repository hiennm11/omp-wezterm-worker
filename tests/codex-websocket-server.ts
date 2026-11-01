/**
 * A WebSocket server for the tests of the Codex client.
 *
 * The client of the app server speaks the WebSocket protocol. Node has no
 * WebSocket server, so the helper answers the upgrade handshake itself and
 * sends the frames of the protocol. The helper needs no program of the
 * machine.
 *
 * The order of the frames matters for a test. The helper sends a frame only
 * when the test asks for it, and it can end the connection. The test waits
 * for the end of the connection, because the TCP protocol delivers the data
 * of a frame before the end of the connection.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

/** The GUID of the WebSocket handshake. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The server of the test. */
export interface FakeWsServer {
	/** The port that the server bound. */
	port: number;
	/** The frames that the server sent, as text. */
	sent: string[];
	/** The frames that the server received, as text. */
	received: string[];
	/** Send one text frame to the client. */
	send: (text: string) => void;
	/**
	 * End the connection of the client.
	 *
	 * The TCP protocol delivers the data of a frame before the end of the
	 * connection. A test that waits for the end of the connection knows
	 * that the client read the frame.
	 */
	endConnection: () => Promise<void>;
	/** Close the server and every connection. */
	close: () => Promise<void>;
}

/**
 * Start a WebSocket server.
 *
 * The server answers the handshake of the first client. It sends the frame
 * of the initialization, so the client of the test connects.
 */
export async function startFakeWsServer(): Promise<FakeWsServer> {
	const sent: string[] = [];
	const received: string[] = [];
	const sockets = new Set<Duplex>();
	const ended = new Map<Duplex, Promise<void>>();

	const server: Server = createServer();
	server.on("upgrade", (request, socket, head) => {
		void head;
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string") {
			socket.destroy();
			return;
		}
		const accept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		sockets.add(socket);
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				const frame = readFrame(buffer);
				if (!frame) break;
				buffer = buffer.subarray(frame.size);
				received.push(frame.payload);
				/* The client sends the initialize request first. The
				   server answers it, so the client finishes its handshake. */
				if (frame.payload.includes("initialize")) {
					sendFrame(socket, JSON.stringify({ id: 1, result: {} }));
				}
			}
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		ended.set(socket, promise);
		socket.on("error", () => resolve());
		socket.on("close", () => {
			sockets.delete(socket);
			resolve();
		});
		socket.on("finish", () => resolve());
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		port,
		sent,
		received,
		send: (text: string) => {
			sent.push(text);
			for (const socket of sockets) sendFrame(socket, text);
		},
		endConnection: async () => {
			/* The socket ends the write side. The write callback of the
			   last frame runs when the data reached the kernel, and the
			   client reads it before the end of the connection. */
			const waits: Array<Promise<void>> = [];
			for (const socket of sockets) {
				waits.push(
					new Promise<void>((resolve) => {
						socket.write("", () => {
							socket.end();
							resolve();
						});
					}),
				);
			}
			await Promise.all(waits);
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

/** One frame of the WebSocket protocol. */
interface Frame {
	size: number;
	payload: string;
}

/**
 * Read one frame of the WebSocket protocol.
 *
 * The function returns null when the buffer holds no full frame.
 */
function readFrame(buffer: Buffer): Frame | null {
	if (buffer.length < 2) return null;
	const second = buffer[1] ?? 0;
	const masked = (second & 0x80) !== 0;
	let length = second & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < offset + 2) return null;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return null;
		length = Number(buffer.readBigUInt64BE(offset));
		offset += 8;
	}
	let mask: Buffer | null = null;
	if (masked) {
		if (buffer.length < offset + 4) return null;
		mask = buffer.subarray(offset, offset + 4);
		offset += 4;
	}
	if (buffer.length < offset + length) return null;
	const payload = buffer.subarray(offset, offset + length);
	if (mask) {
		const plain = Buffer.from(payload);
		for (let index = 0; index < plain.length; index += 1) {
			const byte = plain[index] ?? 0;
			const key = mask[index % 4] ?? 0;
			plain[index] = byte ^ key;
		}
		return { size: offset + length, payload: plain.toString("utf8") };
	}
	return { size: offset + length, payload: payload.toString("utf8") };
}

/**
 * Send one text frame.
 *
 * The server never masks a frame, because the protocol allows that.
 */
function sendFrame(socket: Duplex, text: string): void {
	const payload = Buffer.from(text, "utf8");
	const header =
		payload.length < 126
			? Buffer.from([0x81, payload.length])
			: Buffer.concat([
					Buffer.from([0x81, 126]),
					(() => {
						const size = Buffer.alloc(2);
						size.writeUInt16BE(payload.length);
						return size;
					})(),
				]);
	socket.write(Buffer.concat([header, payload]));
}

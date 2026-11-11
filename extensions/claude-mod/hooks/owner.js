/**
 * The owner of a Claude Code worker.
 *
 * The owner is the main session that started the worker. The mod reads the
 * address and the token of the owner from the environment of the session,
 * and it reads them again on every poll from the handover file. A new owner
 * writes the file again, so a worker that keeps running after a release
 * finds its new owner.
 */

import { saveObservation } from "./background.js";

/** The state of the owner. It lives in the closure of the mod. */
export const state = {
	/** The native session id of the session. */
	sessionId: null,
	/** The id of the run that the session belongs to. */
	runId: null,
	/** The base URL of the owner. */
	baseUrl: null,
	/** The bearer token of the owner. */
	token: null,
	/** The file that holds the address and the token of the current owner. */
	handoverPath: null,
	/** The cycle that the native program delivered last. */
	deliveredCycleId: null,
	/** The calls that started and did not settle. */
	openCalls: new Map(),
	/** The calls that started a background task, by the id of the task. */
	backgroundCalls: new Map(),
	/** The permission requests that no result resolved. */
	pendingApprovals: new Map(),
	/** The commands that the owner handed out. */
	commands: new Map(),
	/** The instruction that the mod submitted and that no turn carries yet. */
	pendingInstructionId: null,
	/** True while a turn of the session runs. */
	turnOpen: false,
	/** True when a new owner needs the snapshot of the run. */
	snapshotDue: false,
	/** True when the owner closed the bridge. The mod stops then. */
	closed: false,
	/** The ids of the notes that the worker received. */
	deliveredNotes: new Set(),
	/** The directory of the session. It holds the file of the delivered notes. */
	sessionDir: null,
	/** The label that a note of the main session carries. The bridge names it. */
	noteLabel: "",
};

/**
 * Read the address and the token of the current owner.
 *
 * The owner writes them into a file inside the session directory. A new
 * owner writes the file again, so a worker that keeps running after a
 * release finds its new owner. A missing or malformed file gives null, and
 * the caller keeps the address that it already has.
 */
export async function readHandover($) {
	const path = state.handoverPath;
	if (!path) return null;
	try {
		const text = await $.fs.read(path);
		if (typeof text !== "string" || !text) return null;
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.url !== "string" || !parsed.url) return null;
		if (typeof parsed.token !== "string" || !parsed.token) return null;
		return { url: parsed.url, token: parsed.token };
	} catch {
		return null;
	}
}

/**
 * Send one observation to the owner.
 *
 * Background observations are saved before the post. File errors do not stop
 * the session, and every other observation keeps its previous behavior.
 */
export async function observe($, source, payload) {
	if (["background.started", "background.settled", "background.stopped"].includes(source)) {
		try {
			await saveObservation($, state, source, payload);
		} catch {
			/* the session keeps running when observation evidence cannot be saved */
		}
	}
	if (state.closed) return;
	if (!state.baseUrl || !state.token) return;
	try {
		await $.http.fetch(`${state.baseUrl}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${state.token}`,
			},
			body: JSON.stringify({
				backend: "claude",
				runId: state.runId,
				sessionId: state.sessionId,
				source,
				payload,
			}),
		});
	} catch {
		/* saved reports and background observations survive a closed bridge */
	}
}

/**
 * Send the snapshot of the run to the current owner.
 *
 * A new owner starts with an empty memory of the run. The mod sends the
 * snapshot when the address of the owner changes. The mod sends it again
 * until the owner accepts it, because a lost snapshot leaves the new owner
 * blind.
 */
export async function sendSnapshot($) {
	if (!state.snapshotDue) return;
	if (state.closed) return;
	if (!state.baseUrl || !state.token) return;
	const payload = {
		takenAt: Date.now(),
		deliveredCycleId: state.deliveredCycleId,
		turnOpen: state.turnOpen,
		pendingInstructionId: state.pendingInstructionId,
		openCalls: [...state.openCalls],
		pendingApprovals: [...state.pendingApprovals],
	};
	try {
		const response = await $.http.fetch(`${state.baseUrl}/observations`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${state.token}`,
			},
			body: JSON.stringify({
				backend: "claude",
				runId: state.runId,
				sessionId: state.sessionId,
				source: "state.snapshot",
				payload,
			}),
		});
		/* The owner accepted the snapshot only with a status below 300.
		   Any other status leaves the flag, so the next poll tries again. */
		if (response.status < 300) state.snapshotDue = false;
	} catch {
		/* the next poll sends the snapshot again */
	}
}

/** Report the result of one command to the owner. */
export async function reportCommand($, id, phase, nativeId, error) {
	if (!state.baseUrl || !state.token) return;
	try {
		await $.http.fetch(`${state.baseUrl}/command-results`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${state.token}`,
			},
			body: JSON.stringify({ id, phase, nativeId: nativeId ?? null, error: error ?? null }),
		});
	} catch {
		/* the owner records the loss */
	}
}

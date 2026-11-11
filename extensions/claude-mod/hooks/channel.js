/**
 * The note channel of a Claude Code worker.
 *
 * The worker and the main session exchange short notes. The mod asks the
 * bridge for the notes of the main session and gives them to the worker as
 * its next prompt. The worker writes a note through the same bridge.
 *
 * A note is not a task. The mod submits the note as a prompt of the session,
 * and the host starts a turn with it. The mod marks that turn, so the owner
 * never counts it as an instruction cycle of the worker.
 */

/** The name of the tool that writes a note to the main session. */
export const NOTE_TO_MAIN = "wezterm_worker_note_to_main";

/** The name of the tool that reads the notes of the main session. */
export const NOTES_FROM_MAIN = "wezterm_worker_notes_from_main";

/** The name that the native host uses for the note tool. */
export const MCP_NOTE_TO_MAIN = `mcp__wezterm-worker__${NOTE_TO_MAIN}`;

/** The name that the native host uses for the notes tool. */
export const MCP_NOTES_FROM_MAIN = `mcp__wezterm-worker__${NOTES_FROM_MAIN}`;

/** The name of the file that holds the notes that the worker received. */
const DELIVERED_FILE = ".wezterm-worker-note-delivered.json";

/** The label that a note of the main session carries. */
export const NOTE_LABEL = "Note from the main session:";

/**
 * The text that a turn carries when it delivers a note.
 *
 * The host names the mod as the sender of a submitted prompt, so the text of
 * the turn holds the note and the label.
 */
export function carriesNote(text) {
	return typeof text === "string" && text.includes(NOTE_LABEL);
}

/**
 * The description of the tool that writes a note.
 *
 * The text matches the description of the tool of an OMP worker, so the main
 * session never needs to know the backend of a worker.
 */
export const NOTE_TO_MAIN_DESCRIPTION =
	"Write a short note to the main session. " +
	"A note changes no state of the task and it does not wake the main session. " +
	"The main session reads the notes with its own tool.";

/**
 * The description of the tool that reads the notes.
 *
 * The text matches the description of the tool of an OMP worker.
 */
export const NOTES_FROM_MAIN_DESCRIPTION =
	"Read the notes that the main session wrote for you. " +
	"Call it at the start of each instruction cycle and before you report completed. " +
	"Pass the number of the last note that you read, or 0 for the first read.";

/**
 * The address and the identity of the owner of a run.
 *
 * The context names the owner of the run and the state of the session. The
 * fields are: baseUrl, token, runId, sessionId, sessionDir, closed and
 * blocked.
 */

/** The file that holds the notes that the worker received. */
function deliveredFile(context) {
	if (!context.sessionDir) return null;
	return `${context.sessionDir}/${DELIVERED_FILE}`;
}

/**
 * The ids of the notes that the worker already received.
 *
 * The ids live in a file, so a restart of the session never submits a note
 * twice.
 */
export async function readDelivered($, context) {
	const path = deliveredFile(context);
	const ids = new Set();
	if (!path) return ids;
	try {
		const text = await $.fs.read(path);
		if (typeof text !== "string" || !text) return ids;
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return ids;
		for (const id of parsed) {
			if (typeof id === "string") ids.add(id);
		}
	} catch {
		/* a missing file holds no delivered note */
	}
	return ids;
}

/** Save the ids of the notes that the worker received. */
async function saveDelivered($, context, ids) {
	const path = deliveredFile(context);
	if (!path) return;
	try {
		await $.fs.write(path, JSON.stringify([...ids]));
	} catch {
		/* the delivery of a note matters more than the file */
	}
}

/**
 * The notes of the main session that the worker has not received.
 *
 * The bridge holds the channel of the run. A request for another run finds
 * no note.
 */
async function fetchMainNotes($, context, afterSeq) {
	const url = `${context.baseUrl}/channel/notes?runId=${encodeURIComponent(context.runId ?? "")}&afterSeq=${afterSeq}`;
	const response = await $.http.fetch(url, {
		headers: { authorization: `Bearer ${context.token}` },
	});
	if (!response.ok) return { notes: [], highestSeq: afterSeq, text: "" };
	const body = JSON.parse(response.text);
	const notes = Array.isArray(body?.notes) ? body.notes : [];
	return {
		notes,
		highestSeq: typeof body?.highestSeq === "number" ? body.highestSeq : afterSeq,
		text: typeof body?.text === "string" ? body.text : "",
	};
}

/**
 * Deliver the pending notes of the main session to the worker.
 *
 * A note reaches the worker one time. The mod records the id of the note,
 * so a later poll never submits it again. A note that waits for a permission
 * request stays pending, because the mod refuses a command in that state.
 *
 * The function returns the number of notes that it submitted.
 */
export async function deliverMainNotes($, context, delivered) {
	if (context.closed) return 0;
	if (!context.baseUrl || !context.token) return 0;
	/* A permission request holds the session. A note waits for it, the same
	   rule that a steering instruction follows. */
	if (context.blocked) return 0;
	let selection;
	try {
		selection = await fetchMainNotes($, context, 0);
	} catch {
		/* the next poll tries again */
		return 0;
	}
	let submitted = 0;
	for (const note of selection.notes) {
		if (!note || typeof note.id !== "string" || delivered.has(note.id)) continue;
		const text = typeof note.text === "string" ? note.text : "";
		if (!text) continue;
		try {
			await $.prompt.submit({ text });
		} catch {
			/* the note stays pending, so the next poll tries again */
			return submitted;
		}
		delivered.add(note.id);
		submitted += 1;
	}
	if (submitted > 0) await saveDelivered($, context, delivered);
	return submitted;
}

/**
 * Write a note of the worker to the channel.
 *
 * The bridge owns the file of the channel, so the mod never writes it.
 */
export async function writeNote($, context, text) {
	const body = JSON.stringify({ runId: context.runId, text });
	const response = await $.http.fetch(`${context.baseUrl}/channel/notes`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${context.token}`,
		},
		body,
	});
	const parsed = JSON.parse(response.text);
	if (!response.ok) {
		return { isError: true, result: String(parsed?.error ?? "the note was not saved") };
	}
	return {
		result: String(parsed?.text ?? "The note is in the channel of the main session."),
	};
}

/**
 * Read the notes of the main session for the worker.
 *
 * The read is stateless. The caller passes the number of the last note that
 * it read, and the default is 0. A read marks the notes as read for the
 * worker, so the mod never submits them again.
 */
export async function readNotes($, context, afterSeq, delivered) {
	const selection = await fetchMainNotes($, context, afterSeq);
	for (const note of selection.notes) {
		if (note && typeof note.id === "string") delivered.add(note.id);
	}
	await saveDelivered($, context, delivered);
	return { result: selection.text };
}

/** Register the two tools of the note channel. */
export async function registerNoteTools(registerTool) {
	await registerTool({
		name: NOTE_TO_MAIN,
		description: NOTE_TO_MAIN_DESCRIPTION,
		isDeferred: false,
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The text of the note. At most 4000 characters." },
			},
			required: ["text"],
		},
	});
	await registerTool({
		name: NOTES_FROM_MAIN,
		description: NOTES_FROM_MAIN_DESCRIPTION,
		isDeferred: false,
		inputSchema: {
			type: "object",
			properties: {
				afterSeq: {
					type: "number",
					description:
						"The number of the last note that you read. The default is 0, which gives every note.",
				},
			},
		},
	});
}

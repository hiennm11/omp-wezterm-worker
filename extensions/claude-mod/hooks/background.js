/**
 * The background tasks of a Claude Code worker.
 *
 * A background task outlives the call that started it. The mod reads the ids
 * of the task and of its call from the text of the transcript, because the
 * host writes them there. The text is a host format and not a documented
 * field, so a new build of the host can change it.
 */

/* The host text of a background task. The tags are text and not a documented
   field, so a new build of the host can change them. */
const BACKGROUND_ID_PATTERN = /Command running in background with ID: (\w+)/;
const STOPPED_MESSAGE_PREFIX = "Successfully stopped task";
const TASK_ID_TAG = /<task-id>([^<]*)<\/task-id>/;
const TOOL_USE_ID_TAG = /<tool-use-id>([^<]*)<\/tool-use-id>/;
const STATUS_TAG = /<status>([^<]*)<\/status>/;

/** The result blocks of a transcript row, with their text and their call. */
export function readResultBlocks(e) {
	const content = e.message?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((block) => block?.type === "tool_result")
		.map((block) => ({
			callId: block?.tool_use_id ?? null,
			text: typeof block?.content === "string" ? block.content : (block?.text ?? null),
		}));
}

/** The text of a transcript row, or null when it carries none. */
export function readRowText(e) {
	const content = e.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
			.join("\n");
	}
	return null;
}

/**
 * The task that a result of a background call names, with its call id.
 *
 * The host writes the id of the task into the text of the result. The text
 * is a host format and not a documented field, so a new build can change it.
 */
export function readBackgroundTask(e) {
	for (const block of readResultBlocks(e)) {
		const match = block.text ? BACKGROUND_ID_PATTERN.exec(block.text) : null;
		if (match) return { taskId: match[1], callId: block.callId };
	}
	return null;
}

/**
 * The task that a stop of a task names.
 *
 * The host writes the id of the task into the JSON text of the result. The
 * text is a host format and not a documented field, so a new build can change
 * it.
 */
export function readStoppedTaskId(e) {
	for (const block of readResultBlocks(e)) {
		let parsed = null;
		try {
			parsed = JSON.parse(block.text ?? "");
		} catch {
			continue;
		}
		const message = parsed?.message;
		if (typeof message !== "string" || !message.startsWith(STOPPED_MESSAGE_PREFIX)) continue;
		if (typeof parsed.task_id === "string" && parsed.task_id) return parsed.task_id;
	}
	return null;
}

/** The text of a tag of a notification, or null when the tag is missing. */
export function readTag(text, pattern) {
	if (typeof text !== "string") return null;
	const match = pattern.exec(text);
	const value = match ? match[1].trim() : "";
	return value ? value : null;
}

/** Save a run-ending background observation in JSONL format. */
export async function saveObservation($, state, source, payload) {
	const path = observationFilePath(state);
	let previous = "";
	try {
		const text = await $.fs.read(path);
		if (typeof text === "string") previous = text;
	} catch {
		/* the first observation creates the file */
	}
	await $.fs.write(
		path,
		`${previous}${JSON.stringify({ backend: "claude", runId: state.runId, sessionId: state.sessionId, source, payload, at: Date.now() })}\n`,
	);
}

/** The observation file of the current run, beside the report file. */
export function observationFilePath(state) {
	const path = state.handoverPath;
	if (!path || !state.runId) throw new Error("the report file path is unavailable");
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const directory = separator < 0 ? "." : path.slice(0, separator);
	return `${directory}/.wezterm-worker-observations-${state.runId}.jsonl`;
}

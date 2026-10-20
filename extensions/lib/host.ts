/**
 * The parts of the OMP extension API that this extension uses.
 *
 * The published type stub is incomplete, so the shapes are declared here.
 */

/** A zod schema builder as the extension API exposes it. */
export interface ZodSchema {
	optional: () => ZodSchema;
	describe: (text: string) => ZodSchema;
}

export interface ZodLike {
	string: () => ZodSchema;
	number: () => ZodSchema;
	boolean: () => ZodSchema;
	array: (item: unknown) => ZodSchema;
	object: (shape: Record<string, unknown>) => unknown;
}

/**
 * The context an event handler receives.
 *
 * `setInterval` is the host's managed timer: the callback runs with the same
 * isolation as a handler dispatch, so a throw is logged and reported instead
 * of tearing the session down.
 */
export interface EventCtx {
	cwd?: string;
	setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (timer: NodeJS.Timeout) => void;
}

/** The context a tool receives. */
export interface ToolCtx {
	cwd: string;
	/** Read-only view of the calling session. */
	sessionManager?: { getSessionFile?: () => string | null | undefined };
}

export interface ExtensionAPI {
	registerTool: (def: unknown) => void;
	registerCommand: (name: string, def: unknown) => void;
	/** Register an event handler. */
	on: (event: string, handler: (event: unknown, ctx: EventCtx) => void | Promise<void>) => void;
	/** Label shown by the host for this extension. */
	setLabel?: (label: string) => void;
	logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
	/**
	 * Inject a message into the session.
	 *
	 * `sendUserMessage` is the channel that reliably wakes the main agent:
	 * the text lands in the session as a user message and `triggerTurn`
	 * starts a new turn. Verified against omp 18.12.3.
	 */
	sendUserMessage?: (text: string, options?: { triggerTurn?: boolean }) => void;
	/**
	 * Inject a message with an explicit delivery mode.
	 *
	 * `deliverAs: "steer"` delivers immediately and `triggerTurn` starts a
	 * turn; `"followUp"` queues the message behind the current turn. Used as
	 * a fallback when `sendUserMessage` is unavailable.
	 */
	sendMessage: (
		content: string,
		options?: {
			deliverAs?: "steer" | "followUp" | "nextTurn" | "aside";
			triggerTurn?: boolean;
			attribution?: "user" | "agent";
		},
	) => void;
	zod: ZodLike;
}

/**
 * The types of the mod of the worker.
 *
 * The mod runs inside the Claude Code host, so it stays plain JavaScript.
 * The declaration gives the type check of the repository the shape of the
 * mod that its tests drive.
 */

/** The event that the mod passes on unchanged. */
export type ModEvent = Record<string, unknown>;

/** The next handler of the host. */
export type ModNext = (event: ModEvent) => unknown;

/** The dollar of the host. */
export type ModDollar = Record<string, unknown>;

/** The handler of one event. */
export type ModHandler = (dollar: ModDollar, event: ModEvent, next: ModNext) => unknown;

/** The matcher of a handler. */
export type ModMatcher = { tool?: string };

/** The registration function of the host. */
export type ModOn = (
	event: string,
	matcher: ModMatcher | ModHandler | undefined,
	handler?: ModHandler,
) => void;

/** Register the hooks of the worker. */
export function register(on: ModOn): void;

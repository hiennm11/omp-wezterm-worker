/**
 * The removal of a directory that a process may still hold.
 *
 * A test removes its temp directory at the end. On Windows a process that is
 * ending still holds its working directory, so the removal fails with EBUSY.
 */

import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** The longest wait for a process to let go of a directory. */
const REMOVE_WAIT_MS = 60_000;

/** The pause between two attempts to remove a directory. */
const REMOVE_RETRY_MS = 250;

/** The errors that mean a process still holds the directory. */
const HELD_CODES: Record<string, true> = { EBUSY: true, EPERM: true, ENOTEMPTY: true };

/**
 * Remove a directory, and wait while a process holds it.
 *
 * The `maxRetries` option of `rmSync` does not wait for this error: a measure
 * on a held directory returned EBUSY after 2 ms. A real held directory freed
 * after 17 seconds in a measured run, so the loop here waits up to `waitMs`
 * in real time.
 *
 * A directory that stays held after the wait is a leftover in the temp
 * folder. It does not decide the result of a test, so the function warns and
 * returns. Any other error still throws.
 */
export async function removeDir(path: string, options: { waitMs?: number } = {}): Promise<void> {
	const waitMs = options.waitMs ?? REMOVE_WAIT_MS;
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (!Object.hasOwn(HELD_CODES, code)) throw error;
			if (Date.now() >= deadline) {
				console.warn(`removeDir: ${path} is still held after ${waitMs} ms (${code}).`);
				return;
			}
		}
		await delay(REMOVE_RETRY_MS);
	}
}

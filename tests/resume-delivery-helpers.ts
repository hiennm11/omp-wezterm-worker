/**
 * The fake of the Herdr CLI for the tests of a resume.
 *
 * A resume shares the transcript of its source run. The fake therefore
 * appends to that transcript, instead of writing a new file.
 *
 * The fake models the two cases of issue 249:
 *
 * - `bootstrap-only`: the fake appends only the entry of the memory plugin.
 *   The message stays in the composer, so the resume fails.
 * - `message`: the fake records the message as a user message, so the
 *   resume succeeds.
 */

import { appendSessionEntry, bootstrapEntry, userMessageEntry } from "./delivery-helpers.ts";
import { type HerdrFake, herdrFake } from "./herdr-fake.ts";

/** The delivery that the fake models. */
export type ResumeDelivery = "bootstrap-only" | "message";

/**
 * The fake of Herdr for a resume.
 *
 * The fake opens one pane with the id `w1:p101`, so a test can name the
 * pane that the launch sends the Enter key to.
 */
export function resumeFake(delivery: ResumeDelivery, sessionDir: string): HerdrFake {
	const fake = herdrFake({ sessionDir, delivery: "never", nextPane: 101 });
	const original = fake.answer;
	fake.answer = (args: string[]) => {
		if (args[0] === "agent" && args[1] === "prompt") {
			/* The memory plugin writes its entry at the start of every
			   session. The entry grows the transcript, but it records no
			   user message. */
			appendSessionEntry(sessionDir, bootstrapEntry());
			if (delivery === "message") {
				appendSessionEntry(sessionDir, userMessageEntry(args[3] ?? ""));
			}
		}
		return original(args);
	};
	return fake;
}

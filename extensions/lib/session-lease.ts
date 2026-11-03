/**
 * The lease of a session.
 *
 * OMP holds a lease for every session. The key of the lease is the session
 * id. A process holds the lease of a session only after the first write of
 * that session. The host releases the lease when the session closes, and the
 * kernel releases it when the process exits.
 *
 * A live process does not prove that its session is open. The lease does.
 * The lease is the evidence that no process holds the session.
 *
 * The host exports the lease API as `pi.pi` at run time. A host without that
 * API cannot answer, and the caller treats the missing answer as unknown.
 */

import type { ExtensionAPI } from "./host.ts";

/**
 * The answer of the host about the lease of a session.
 *
 * `true`: a process holds the lease of the session.
 * `false`: no process holds the lease of the session.
 * `null`: the host cannot answer.
 */
export type LeaseAnswer = boolean | null;

/**
 * Read the lease of a session.
 *
 * The function returns a promise. A missing API, a throw, a rejection, or a
 * value that is not a boolean gives null. The caller never guesses.
 */
export type LeaseProbe = (sessionId: string) => Promise<LeaseAnswer>;

/**
 * Build the probe of the lease of a session.
 *
 * The host gives the probe at run time, so the probe reads the API each
 * time it runs. A host that changes its API needs no new probe.
 */
export function createLeaseProbe(pi: ExtensionAPI): LeaseProbe {
	return async (sessionId: string): Promise<LeaseAnswer> => {
		const probe = pi.pi?.isSessionLeaseHeld;
		if (typeof probe !== "function") return null;
		try {
			const answer = await probe.call(pi.pi, sessionId);
			if (answer === true || answer === false) return answer;
			return null;
		} catch {
			return null;
		}
	};
}

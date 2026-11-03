import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "../extensions/lib/host.ts";
import { createLeaseProbe } from "../extensions/lib/session-lease.ts";

/** A host API that holds the given lease API. */
function hostWith(pi: unknown): ExtensionAPI {
	return { pi } as unknown as ExtensionAPI;
}

test("the probe reports that a process holds the lease", async () => {
	const probe = createLeaseProbe(hostWith({ isSessionLeaseHeld: () => true }));
	assert.equal(await probe("session-a"), true);
});

test("the probe reports that the lease is free", async () => {
	const probe = createLeaseProbe(hostWith({ isSessionLeaseHeld: () => false }));
	assert.equal(await probe("session-a"), false);
});

test("the probe awaits a promise of the host", async () => {
	const probe = createLeaseProbe(hostWith({ isSessionLeaseHeld: async () => true }));
	assert.equal(await probe("session-a"), true);
});

test("the probe gives no answer when the host has no lease API", async () => {
	const probe = createLeaseProbe({} as ExtensionAPI);
	assert.equal(await probe("session-a"), null);
});

test("the probe gives no answer when the lease function is missing", async () => {
	const probe = createLeaseProbe(hostWith({}));
	assert.equal(await probe("session-a"), null);
});

test("the probe gives no answer when the call throws", async () => {
	const probe = createLeaseProbe(
		hostWith({
			isSessionLeaseHeld: () => {
				throw new Error("the host cannot answer");
			},
		}),
	);
	assert.equal(await probe("session-a"), null);
});

test("the probe gives no answer when the call rejects", async () => {
	const probe = createLeaseProbe(
		hostWith({
			isSessionLeaseHeld: async () => {
				throw new Error("the host cannot answer");
			},
		}),
	);
	assert.equal(await probe("session-a"), null);
});

test("the probe gives no answer for a value that is not a boolean", async () => {
	const probe = createLeaseProbe(hostWith({ isSessionLeaseHeld: () => "yes" }));
	assert.equal(await probe("session-a"), null);
});

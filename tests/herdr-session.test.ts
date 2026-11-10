/**
 * The guard of a Herdr session.
 *
 * The extension opens panes through Herdr. Herdr runs only inside a session,
 * and it sets the variable HERDR_ENV in every pane of that session. A spawn
 * outside a session must be refused, and the message must name the variable
 * so the user can act on it.
 *
 * The decision is a pure function of the environment. A test checks it
 * without a pane.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { herdrSessionRefusal } from "../extensions/lib/herdr-session.ts";

test("a spawn inside a Herdr session is not refused", () => {
	assert.equal(herdrSessionRefusal({ HERDR_ENV: "1" }), null);
});

test("a spawn outside a Herdr session is refused and the message names the variable", () => {
	const refusal = herdrSessionRefusal({});
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /HERDR_ENV/);
});

test("a spawn with an empty session variable is refused", () => {
	const refusal = herdrSessionRefusal({ HERDR_ENV: "" });
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /HERDR_ENV/);
});

test("a spawn with another value of the session variable is refused", () => {
	const refusal = herdrSessionRefusal({ HERDR_ENV: "0" });
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /HERDR_ENV/);
});

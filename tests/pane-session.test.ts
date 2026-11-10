/**
 * The guard of a pane session.
 *
 * The extension opens panes through Herdr or WezTerm. Herdr runs only inside
 * a session, and it sets the variable HERDR_ENV in every pane of that
 * session. WezTerm sets the variable WEZTERM_PANE in every pane of its
 * session. A spawn outside both must be refused, and the message must name
 * both variables so the user can act on it.
 *
 * The decision is a pure function of the environment. A test checks it
 * without a pane.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { paneSessionRefusal } from "../extensions/lib/pane-session.ts";

test("a spawn inside a Herdr session is not refused", () => {
	assert.equal(paneSessionRefusal({ HERDR_ENV: "1" }, "auto"), null);
});

test("a spawn inside a WezTerm session is not refused", () => {
	assert.equal(paneSessionRefusal({ WEZTERM_PANE: "3" }, "auto"), null);
});

test("a spawn outside both sessions is refused and the message names both variables", () => {
	const refusal = paneSessionRefusal({}, "auto");
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /HERDR_ENV/);
	assert.match(refusal, /WEZTERM_PANE/);
});

test("a spawn with an empty session variable is refused", () => {
	const refusal = paneSessionRefusal({ HERDR_ENV: "" }, "auto");
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /HERDR_ENV/);
});

test("a spawn with another value of the session variable is refused", () => {
	const refusal = paneSessionRefusal({ HERDR_ENV: "0" }, "auto");
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /HERDR_ENV/);
});

test("a configured runtime is not refused without a session variable", () => {
	assert.equal(paneSessionRefusal({}, "herdr"), null);
	assert.equal(paneSessionRefusal({}, "wezterm"), null);
});

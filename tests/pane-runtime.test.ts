/**
 * The selection of the pane runtime.
 *
 * The extension can open a worker pane through Herdr or through WezTerm. A
 * configuration key selects one runtime. The environment selects one runtime
 * when the key is absent or holds `auto`.
 *
 * The functions are pure. The tests read no pane and start no process.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runtimeRefusal, selectPaneRuntime } from "../extensions/lib/pane-runtime.ts";

test("a configured runtime wins over the environment", () => {
	assert.equal(selectPaneRuntime({ HERDR_ENV: "1" }, "wezterm"), "wezterm");
	assert.equal(selectPaneRuntime({ WEZTERM_PANE: "3" }, "herdr"), "herdr");
});

test("the value auto reads the variable of Herdr", () => {
	assert.equal(selectPaneRuntime({ HERDR_ENV: "1" }, "auto"), "herdr");
});

test("the value auto reads the variable of WezTerm", () => {
	assert.equal(selectPaneRuntime({ WEZTERM_PANE: "3" }, "auto"), "wezterm");
});

test("no signal gives no runtime", () => {
	assert.equal(selectPaneRuntime({}, "auto"), null);
});

test("an empty variable of WezTerm gives no runtime", () => {
	assert.equal(selectPaneRuntime({ WEZTERM_PANE: "" }, "auto"), null);
});

test("another value of the variable of Herdr gives no runtime", () => {
	assert.equal(selectPaneRuntime({ HERDR_ENV: "0" }, "auto"), null);
});

test("a runtime exists, so no refusal is needed", () => {
	assert.equal(runtimeRefusal({ HERDR_ENV: "1" }, "auto"), null);
	assert.equal(runtimeRefusal({ WEZTERM_PANE: "3" }, "auto"), null);
	assert.equal(runtimeRefusal({}, "herdr"), null);
	assert.equal(runtimeRefusal({}, "wezterm"), null);
});

test("a refusal names both runtimes and both variables", () => {
	const refusal = runtimeRefusal({}, "auto");
	assert.ok(refusal, "the spawn was not refused");
	assert.match(refusal, /Herdr/);
	assert.match(refusal, /WezTerm/);
	assert.match(refusal, /HERDR_ENV/);
	assert.match(refusal, /WEZTERM_PANE/);
});

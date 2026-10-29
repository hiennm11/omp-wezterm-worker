import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	initializeParams,
	observationOf,
	reportServerArgs,
	secretFields,
} from "../tooling/backend-proof/codex.ts";
import {
	type CodexProofOptions,
	mayEndCodexProcess,
	optionsForScenario,
	verdictWithEvidence,
} from "../tooling/backend-proof/codex-handle.ts";
import { approvalDialogShown } from "../tooling/backend-proof/codex-tui.ts";
import { createEvidenceStore } from "../tooling/backend-proof/evidence.ts";

const ROOT = join(import.meta.dirname, "..");

/** The text of a real pane of the Codex TUI that shows the approval dialog. */
const APPROVAL_PANE = readFileSync(join(ROOT, "tests", "fixtures", "codex-approval-pane.txt"), "utf8");

/** The options of one proof run, for the tests of the Codex scenarios. */
function testOptions(): CodexProofOptions {
	const dir = mkdtempSync(join(tmpdir(), "proof-codex-"));
	return {
		args: { backend: "codex", scenario: "all", evidenceDir: dir },
		runId: "proof-codex-test",
		evidence: createEvidenceStore(dir, "codex", "proof-codex-test"),
	};
}

test("a notification gives the source of its method", () => {
	const observation = observationOf({ method: "turn/started", params: { turn: { id: "t1" } } });
	assert.equal(observation.source, "codex.turn/started");
	assert.deepEqual(observation.payload, { turn: { id: "t1" } });
});

test("a request gives the source of its method", () => {
	const observation = observationOf({ id: 4, method: "item/commandExecution/requestApproval" });
	assert.equal(observation.source, "codex.item/commandExecution/requestApproval");
});

test("a response gives the source of a response and keeps its id", () => {
	const observation = observationOf({ id: 7, result: { ok: true } });
	assert.equal(observation.source, "codex.response");
	assert.deepEqual(observation.payload, { id: 7, result: { ok: true } });
});

test("a message without a method and without an id gives the unknown source", () => {
	const observation = observationOf({});
	assert.equal(observation.source, "codex.unknown");
});

test("the initialize request holds no token", () => {
	assert.deepEqual(secretFields(initializeParams()), []);
});

test("the real pane text of the approval dialog shows the dialog", () => {
	assert.equal(approvalDialogShown(APPROVAL_PANE), true);
});

test("a pane text without a dialog does not show the dialog", () => {
	assert.equal(approvalDialogShown("OpenAI Codex (v0.165.0)\nAsk Codex to do anything"), false);
});

test("an empty pane text does not show the dialog", () => {
	assert.equal(approvalDialogShown(""), false);
});

test("the report server options name the proof variables", () => {
	const args = reportServerArgs("C:/proof/report-server.ts");
	const option = args.find((arg) => arg.includes("env_vars="));
	assert.ok(option, "the options hold no env_vars option");
	assert.match(option, /WEZTERM_PROOF_URL/);
	assert.match(option, /WEZTERM_PROOF_TOKEN/);
	assert.match(option, /WEZTERM_PROOF_RUN_ID/);
});

test("the report server options hold no token value and no url value", () => {
	const args = reportServerArgs("C:/proof/report-server.ts");
	const text = args.join(" ");
	assert.equal(text.includes("secret-token"), false);
	assert.equal(text.includes("http://127.0.0.1"), false);
});

test("the report server options keep the command and the path", () => {
	const args = reportServerArgs("C:/proof/report-server.ts");
	assert.ok(args.includes('mcp_servers.wezterm_worker_proof.command="node"'));
	assert.ok(args.includes('mcp_servers.wezterm_worker_proof.args=["C:/proof/report-server.ts"]'));
});

test("the options of one scenario hold a list of their own", () => {
	const options = testOptions();
	const first = optionsForScenario(options);
	const second = optionsForScenario(options);
	assert.notEqual(first.observations, second.observations);
	assert.notEqual(first.observations, options.observations);
});

test("the options of one scenario keep the evidence store of the run", () => {
	const options = testOptions();
	const own = optionsForScenario(options);
	assert.equal(own.evidence, options.evidence);
	assert.equal(own.runId, options.runId);
	assert.equal(own.args, options.args);
});

test("an observation of one scenario stays out of the list of another scenario", () => {
	const options = testOptions();
	const first = optionsForScenario(options);
	const second = optionsForScenario(options);
	first.observations.push({ source: "report", payload: {} });
	assert.equal(second.observations.length, 0);
});

test("a scenario that wrote no evidence does not pass", () => {
	const verdict = verdictWithEvidence("observe", "pass", "the report arrived", 0);
	assert.equal(verdict.verdict, "fail");
	assert.equal(verdict.detail, "the scenario wrote no evidence");
});

test("a scenario that wrote evidence keeps its verdict", () => {
	const verdict = verdictWithEvidence("observe", "pass", "the report arrived", 3);
	assert.equal(verdict.verdict, "pass");
	assert.equal(verdict.detail, "the report arrived");
});

test("a scenario without evidence does not pass even when it failed", () => {
	const verdict = verdictWithEvidence("observe", "fail", "the turn never ended", 0);
	assert.equal(verdict.verdict, "fail");
	assert.equal(verdict.detail, "the scenario wrote no evidence");
});

test("a process of a name that is not codex must not end", () => {
	assert.equal(mayEndCodexProcess("notepad.exe"), false);
});

test("a process of the name codex may end", () => {
	assert.equal(mayEndCodexProcess("codex.exe"), true);
});

test("a process of a name that holds codex but is not codex must not end", () => {
	assert.equal(mayEndCodexProcess("codex-code-mode-host.exe"), false);
});

test("a process without a name must not end", () => {
	assert.equal(mayEndCodexProcess(""), false);
});

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
	type BackgroundFacts,
	backgroundTaskText,
	backgroundVerdict,
} from "../tooling/backend-proof/codex-background.ts";
import {
	type CodexProofOptions,
	mayEndCodexProcess,
	optionsForScenario,
	verdictWithEvidence,
} from "../tooling/backend-proof/codex-handle.ts";
import { approvalDialogShown, commandDialogShown, dialogKind } from "../tooling/backend-proof/codex-tui.ts";
import { createEvidenceStore } from "../tooling/backend-proof/evidence.ts";

const ROOT = join(import.meta.dirname, "..");

/** The text of a real pane of the Codex TUI that shows the approval dialog. */
const APPROVAL_PANE = readFileSync(join(ROOT, "tests", "fixtures", "codex-approval-pane.txt"), "utf8");

/** The text of a real pane of the Codex TUI that shows the command dialog. */
const COMMAND_PANE = readFileSync(join(ROOT, "tests", "fixtures", "codex-command-dialog-pane.txt"), "utf8");

/** The options of one proof run, for the tests of the Codex scenarios. */
function testOptions(): CodexProofOptions {
	const dir = mkdtempSync(join(tmpdir(), "proof-codex-"));
	return {
		args: { backend: "codex", scenario: "all", evidenceDir: dir },
		runId: "proof-codex-test",
		evidence: createEvidenceStore(dir, "codex", "proof-codex-test"),
		observations: [],
	};
}

/** The facts that the tests of the background verdict change. */
interface BackgroundCase {
	/** Whether a command of the turn completed. */
	commandCompleted?: boolean;
	/** The time of the first report. */
	reportAt: number | null;
	/** Whether the background file appeared. */
	fileAppeared: boolean;
	/** The time of the first appearance of the file. */
	fileAt?: number | null;
	/** The content of the background file. */
	fileContent?: string | null;
}

/** Build the facts of one case of the background verdict. */
function backgroundFacts(testCase: BackgroundCase): BackgroundFacts {
	return {
		commandCompleted: testCase.commandCompleted ?? true,
		reportArrived: testCase.reportAt !== null,
		reportAt: testCase.reportAt,
		fileAppeared: testCase.fileAppeared,
		fileAt: testCase.fileAt ?? null,
		fileContent: testCase.fileContent ?? null,
		waitedMs: 40000,
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

test("the real pane text of the command dialog shows the command dialog", () => {
	assert.equal(commandDialogShown(COMMAND_PANE), true);
});

test("the pane text of the MCP dialog does not show the command dialog", () => {
	assert.equal(commandDialogShown(APPROVAL_PANE), false);
});

test("an empty pane text does not show the command dialog", () => {
	assert.equal(commandDialogShown(""), false);
});

test("the pane text of the command dialog shows the command kind", () => {
	assert.equal(dialogKind(COMMAND_PANE), "command");
});

test("the pane text of the MCP dialog shows the MCP kind", () => {
	assert.equal(dialogKind(APPROVAL_PANE), "mcp");
});

test("a pane text without a dialog shows no kind", () => {
	assert.equal(dialogKind("OpenAI Codex (v0.165.0)\nAsk Codex to do anything"), null);
});

test("an empty pane text shows no kind", () => {
	assert.equal(dialogKind(""), null);
});

test("the newest dialog wins when the command dialog is the last one", () => {
	assert.equal(dialogKind(`${APPROVAL_PANE}\n${COMMAND_PANE}`), "command");
});

test("the newest dialog wins when the MCP dialog is the last one", () => {
	assert.equal(dialogKind(`${COMMAND_PANE}\n${APPROVAL_PANE}`), "mcp");
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
	first.observations.push({ source: "report", payload: {}, at: 1 });
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

test("the background task names the absolute path of the file", () => {
	const text = backgroundTaskText("C:/tmp/proof/fixture");
	assert.ok(text.includes("C:/tmp/proof/fixture/bg.txt"), text);
	assert.ok(!text.includes("\\"), text);
	assert.ok(text.includes("BG-DONE"), text);
	assert.ok(text.includes("PROOF-BACKGROUND"), text);
});

test("a background file that appears after the report passes", () => {
	const verdict = backgroundVerdict(
		backgroundFacts({ reportAt: 1000, fileAppeared: true, fileAt: 21000, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "pass");
	assert.ok(verdict.detail.includes("20"), verdict.detail);
});

test("a background file that appears before the report fails", () => {
	const verdict = backgroundVerdict(
		backgroundFacts({ reportAt: 21000, fileAppeared: true, fileAt: 1000, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("background"), verdict.detail);
});

test("a background file that never appears fails", () => {
	const verdict = backgroundVerdict(backgroundFacts({ reportAt: 1000, fileAppeared: false }));
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("40"), verdict.detail);
});

test("a background turn without a report fails", () => {
	const verdict = backgroundVerdict(
		backgroundFacts({ reportAt: null, fileAppeared: true, fileAt: 21000, fileContent: "BG-DONE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("report"), verdict.detail);
});

test("a background file with a wrong content fails", () => {
	const verdict = backgroundVerdict(
		backgroundFacts({ reportAt: 1000, fileAppeared: true, fileAt: 21000, fileContent: "SOMETHING-ELSE" }),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("BG-DONE"), verdict.detail);
});

test("a background turn without a command fails", () => {
	const verdict = backgroundVerdict(
		backgroundFacts({
			commandCompleted: false,
			reportAt: 1000,
			fileAppeared: true,
			fileAt: 21000,
			fileContent: "BG-DONE",
		}),
	);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("command"), verdict.detail);
});

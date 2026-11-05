/**
 * The approval policy of a Codex worker.
 *
 * The policy decides when Codex asks the person for the approval of a
 * command. The setting `codex.approvalPolicy` in the configuration file
 * names the policy. A missing value sends no field, so the worker keeps the
 * policy of the user.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, lastGuidance, loadConfig } from "../extensions/lib/config.ts";

/** The policies that the protocol of the app server accepts. */
const PROTOCOL_POLICIES = ["untrusted", "on-request", "never"];

/** Write a config file and return its path. */
function configFile(content: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "wt-approval-"));
	const file = join(dir, "wezterm-worker.json");
	writeFileSync(file, JSON.stringify(content), "utf8");
	return file;
}

/** The module of the policy. The import fails until the module exists. */
async function policyModule(): Promise<typeof import("../extensions/lib/codex-approval.ts")> {
	return import("../extensions/lib/codex-approval.ts");
}

test("the default sends no approval policy", () => {
	assert.equal(DEFAULT_CONFIG.codexApprovalPolicy, null);
});

test("a valid policy is kept", () => {
	const file = configFile({ codex: { approvalPolicy: "untrusted" } });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.codexApprovalPolicy, "untrusted");
});

test("every policy of the protocol is accepted", () => {
	for (const policy of PROTOCOL_POLICIES) {
		const file = configFile({ codex: { approvalPolicy: policy } });
		const cfg = loadConfig(file, {});
		assert.equal(cfg.codexApprovalPolicy, policy, `the policy ${policy} was refused`);
	}
});

test("an unknown policy is refused with guidance", () => {
	const file = configFile({ codex: { approvalPolicy: "sometimes" } });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.codexApprovalPolicy, null);
	assert.match(lastGuidance ?? "", /approvalPolicy/);
});

test("a missing policy gives null", () => {
	const file = configFile({ codex: {} });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.codexApprovalPolicy, null);
});

test("a config file without the codex section gives null", () => {
	const file = configFile({ model: "some/model" });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.codexApprovalPolicy, null);
});

test("a policy of the wrong type is refused with guidance", () => {
	const file = configFile({ codex: { approvalPolicy: 7 } });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.codexApprovalPolicy, null);
	assert.match(lastGuidance ?? "", /approvalPolicy/);
});

test("a codex section of the wrong type gives null", () => {
	const file = configFile({ codex: "untrusted" });
	const cfg = loadConfig(file, {});
	assert.equal(cfg.codexApprovalPolicy, null);
});

test("the reader keeps a valid policy", async () => {
	const module = await policyModule();
	assert.equal(module.readApprovalPolicy("on-request"), "on-request");
});

test("the reader gives null for a missing value", async () => {
	const module = await policyModule();
	assert.equal(module.readApprovalPolicy(undefined), null);
});

test("the reader gives null for an unknown value", async () => {
	const module = await policyModule();
	assert.equal(module.readApprovalPolicy("sometimes"), null);
});

test("the reader gives null for a value of the wrong type", async () => {
	const module = await policyModule();
	assert.equal(module.readApprovalPolicy(7), null);
});

test("the guard accepts the policies of the protocol", async () => {
	const module = await policyModule();
	assert.equal(module.isApprovalPolicy("untrusted"), true);
	assert.equal(module.isApprovalPolicy("on-request"), true);
	assert.equal(module.isApprovalPolicy("never"), true);
	assert.equal(module.isApprovalPolicy("sometimes"), false);
});

test("the list of the policies names the values of the protocol", async () => {
	const module = await policyModule();
	assert.deepEqual(module.APPROVAL_POLICIES, PROTOCOL_POLICIES);
});

test("the refusal names the valid policies", async () => {
	const module = await policyModule();
	const refusal = module.approvalPolicyRefusal("sometimes");
	assert.match(refusal, /sometimes/);
	assert.match(refusal, /untrusted/);
	assert.match(refusal, /on-request/);
	assert.match(refusal, /never/);
});

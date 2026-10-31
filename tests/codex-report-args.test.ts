/**
 * The arguments that load the report server into the app server of Codex.
 *
 * The token of the bridge must never reach a command line. The test reads
 * every argument and every value of the environment of the launch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { codexReportLaunch } from "../extensions/lib/codex-report.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** The value of one key of the configuration of the app server. */
function configValue(args: string[], key: string): string | undefined {
	const prefix = `${key}=`;
	for (const arg of args) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

test("the arguments name the command of the report server", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	assert.equal(
		configValue(launch.args, "mcp_servers.wezterm_worker_report.command"),
		'"node"',
		"the command of the report server is missing",
	);
});

test("the arguments name the path of the report server", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	const value = configValue(launch.args, "mcp_servers.wezterm_worker_report.args");
	assert.ok(value, "the path of the report server is missing");
	assert.match(value, /report-server\.ts/);
});

test("the arguments name the variables that the report server inherits", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	const value = configValue(launch.args, "mcp_servers.wezterm_worker_report.env_vars");
	assert.ok(value, "the inherited variables are missing");
	assert.match(value, /WEZTERM_WORKER_URL/);
	assert.match(value, /WEZTERM_WORKER_TOKEN/);
	assert.match(value, /WEZTERM_WORKER_RUN_ID/);
});

test("the arguments approve the report tool", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	assert.equal(
		configValue(launch.args, "mcp_servers.wezterm_worker_report.tools.wezterm_worker_report.approval_mode"),
		'"approve"',
	);
});

test("no argument carries the text of the token", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	assert.equal(launch.args.join("\n").includes(TOKEN), false, "the token reached a command argument");
});

test("the arguments never use the key that puts the token into the command line", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	const text = launch.args.join("\n");
	assert.equal(text.includes("mcp_servers.wezterm_worker_report.env="), false);
});

test("the environment carries the address, the token and the run id", () => {
	const launch = codexReportLaunch({ url: "http://127.0.0.1:1234", token: TOKEN, runId: "wz-1" });
	assert.equal(launch.env.WEZTERM_WORKER_URL, "http://127.0.0.1:1234");
	assert.equal(launch.env.WEZTERM_WORKER_TOKEN, TOKEN);
	assert.equal(launch.env.WEZTERM_WORKER_RUN_ID, "wz-1");
});

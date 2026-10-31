/**
 * The report channel of a Codex worker.
 *
 * A Codex worker reports through an MCP server that the extension loads
 * into the app server. The server posts every report to the bridge of the
 * run, and the owner reads the report from the run state.
 *
 * The token of the bridge reaches the app server through the environment of
 * the launch. The setting `env_vars` names the variables that the app
 * server passes to the report server. The setting `env` would put the token
 * value into the command line of the program, so the extension never uses
 * it.
 *
 * The function of this module is pure. It reads no state of the run and it
 * starts no program, so a test can check the arguments without a pane.
 */

import { join } from "node:path";

/** The name of the MCP server and of its report tool. */
export const CODEX_REPORT_NAME = "wezterm_worker_report";

/** The variables that the report server inherits from the app server. */
const REPORT_ENV_VARS = [
	"WEZTERM_WORKER_URL",
	"WEZTERM_WORKER_TOKEN",
	"WEZTERM_WORKER_RUN_ID",
	"WEZTERM_WORKER_SESSION_DIR",
];

/** The path of the report server program. */
const REPORT_SERVER_PATH = join(import.meta.dirname, "..", "codex-report", "report-server.ts");

/** The bridge that the report server of a run posts to. */
export interface CodexReportTarget {
	/** The address of the bridge of the run. */
	url: string;
	/** The token that every request of the bridge must carry. */
	token: string;
	/** The id of the run. */
	runId: string;
	/** The session directory of the run. The report server reads the handover file there. */
	sessionDir: string;
}

/** The arguments and the environment of the launch of a Codex worker. */
export interface CodexReportLaunch {
	/** The arguments that the app server reads as configuration overrides. */
	args: string[];
	/** The environment of the pane of the app server. */
	env: NodeJS.ProcessEnv;
}

/**
 * Build the arguments and the environment of the report channel.
 *
 * The arguments name the command, the path and the inherited variables of
 * the report server. They approve the report tool only, so the person keeps
 * the approval of a shell command.
 *
 * The token never reaches an argument. It reaches the report server through
 * the environment of the launch.
 */
export function codexReportLaunch(target: CodexReportTarget): CodexReportLaunch {
	const server = REPORT_SERVER_PATH.replace(/\\/g, "/");
	return {
		args: [
			"-c",
			`mcp_servers.${CODEX_REPORT_NAME}.command="node"`,
			"-c",
			`mcp_servers.${CODEX_REPORT_NAME}.args=["${server}"]`,
			"-c",
			`mcp_servers.${CODEX_REPORT_NAME}.env_vars=[${REPORT_ENV_VARS.map((name) => `"${name}"`).join(",")}]`,
			"-c",
			`mcp_servers.${CODEX_REPORT_NAME}.tools.${CODEX_REPORT_NAME}.approval_mode="approve"`,
		],
		env: {
			WEZTERM_WORKER_URL: target.url,
			WEZTERM_WORKER_TOKEN: target.token,
			WEZTERM_WORKER_RUN_ID: target.runId,
			WEZTERM_WORKER_SESSION_DIR: target.sessionDir,
		},
	};
}

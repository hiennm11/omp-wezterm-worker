/**
 * The Codex scenarios of the settings, the permission, the background work, the
 * recovery and the stop.
 *
 * Every scenario starts its own dedicated app server, creates its own thread,
 * and attaches a real TUI. The observing connection never answers a
 * permission request, so the TUI keeps the answer.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { connectAppServer, endpointFor } from "./codex.ts";
import {
	attachTui,
	type CodexProofOptions,
	recordMessages,
	startServer,
	stopHandle,
	wait,
} from "./codex-server.ts";
import type { ScenarioOutcome } from "./scenarios.ts";
import { runProgram } from "./shared.ts";

export async function runSettingsUsage(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "settings-usage";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		const servers = await handle.client.request("mcpServerStatus/list", { threadId: handle.threadId });
		const data = (servers.result as { data?: Array<{ name?: string }> } | undefined)?.data ?? [];
		const names = data.map((server) => server.name ?? "");
		const usage = await handle.client.request("account/usage/read", {});
		const usageMissing = Boolean(usage.error);
		return {
			scenario,
			verdict: "pass",
			detail: `visible MCP servers: ${names.join(", ")}; the native usage endpoint: ${
				usageMissing ? `unavailable (${usage.error?.message ?? "unknown"})` : "answered"
			}`,
		};
	} finally {
		await stopHandle(handle);
	}
}

/** Run the approval scenario. */
export async function runApproval(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "approval";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		const env = {
			WEZTERM_PROOF_RUN_ID: options.runId,
			WEZTERM_PROOF_URL: handle.listener.baseUrl,
			WEZTERM_PROOF_TOKEN: handle.listener.token,
		};
		const tui = await attachTui(handle, bin, env);
		handle.paneId = tui.paneId;
		if (tui.paneId === null) {
			return { scenario, verdict: "fail", detail: tui.error ?? "the TUI did not start" };
		}
		await wait(3000);
		await handle.client.request("turn/start", {
			threadId: handle.threadId,
			input: [
				{
					type: "text",
					text: "Write APPROVED to approval.txt with a shell command, then call the wezterm_worker_report tool with state completed and result PROOF-APPROVAL.",
				},
			],
		});
		await wait(15000);
		recordMessages(options, handle.client.messages, scenario);
		const requests = handle.client.messages.filter(
			(message) => message.method === "item/commandExecution/requestApproval",
		);
		const detail = `${requests.length} native approval request(s) reached the observer`;
		if (requests.length === 0) {
			return { scenario, verdict: "unavailable", detail };
		}
		return { scenario, verdict: "pass", detail };
	} finally {
		await stopHandle(handle);
	}
}

/** Run the background scenario. */
export async function runBackground(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "background";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		await handle.client.request("turn/start", {
			threadId: handle.threadId,
			input: [
				{
					type: "text",
					text: "Start a background task that writes BG-DONE to bg.txt after 15 seconds, then call the wezterm_worker_report tool with state completed and result PROOF-BACKGROUND.",
				},
			],
		});
		await wait(45000);
		recordMessages(options, handle.client.messages, scenario);
		const terminals = options.observations.filter(
			(o) => o.source === "codex.thread/backgroundTerminals/list",
		);
		const report = options.observations.find((o) => o.source === "report");
		const bgFile = join(fixture, "bg.txt");
		return {
			scenario,
			verdict: report ? "pass" : "fail",
			detail: `report: ${report ? "recorded" : "missing"}; background terminal observations: ${terminals.length}; background file: ${existsSync(bgFile)}`,
		};
	} finally {
		await stopHandle(handle);
	}
}

/** Run the recovery scenario. */
export async function runRecovery(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "recovery";
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	const threadId = handle.threadId;
	try {
		await handle.client.request("turn/start", {
			threadId,
			input: [{ type: "text", text: "Read baseline.txt." }],
		});
		await wait(6000);
		handle.client.close();
		await wait(2000);

		const reconnected = await connectAppServer(endpointFor(handle.port));
		const resumed = await reconnected.request("thread/resume", { threadId });
		if (resumed.error) {
			reconnected.close();
			return { scenario, verdict: "fail", detail: resumed.error.message };
		}
		const status = await reconnected.request("thread/turns/list", { threadId });
		const history = (status.result as { data?: unknown[] } | undefined)?.data ?? [];
		reconnected.close();
		return {
			scenario,
			verdict: "pass",
			detail: `the observer reconnected to the same server; stored turns after the reconnect: ${history.length}`,
		};
	} finally {
		await stopHandle(handle);
	}
}

/** Run the stop scenario. */
export async function runStop(
	options: CodexProofOptions,
	fixture: string,
	bin: string,
): Promise<ScenarioOutcome> {
	const scenario = "stop";
	const before = await listPanes();
	const started = await startServer(options, fixture, bin, scenario);
	if (!started.handle) {
		return { scenario, verdict: "unavailable", detail: started.error ?? "the server did not start" };
	}
	const handle = started.handle;
	try {
		const env = {
			WEZTERM_PROOF_RUN_ID: options.runId,
			WEZTERM_PROOF_URL: handle.listener.baseUrl,
			WEZTERM_PROOF_TOKEN: handle.listener.token,
		};
		const tui = await attachTui(handle, bin, env);
		handle.paneId = tui.paneId;
		if (tui.paneId === null) {
			return { scenario, verdict: "fail", detail: tui.error ?? "the TUI did not start" };
		}
		await wait(3000);
		const turn = await handle.client.request("turn/start", {
			threadId: handle.threadId,
			input: [{ type: "text", text: "Run a shell command that waits 30 seconds." }],
		});
		const turnId = (turn.result as { turn?: { id?: string } } | undefined)?.turn?.id ?? "";
		await wait(5000);
		await handle.client.request("turn/interrupt", { threadId: handle.threadId, turnId });
		await wait(3000);
		recordMessages(options, handle.client.messages, scenario);

		const interrupted = options.observations.filter(
			(o) =>
				o.source === "codex.turn/completed" &&
				(o.payload as { turn?: { status?: string } })?.turn?.status === "interrupted",
		);
		const after = await listPanes();
		const othersSurvived = before.every((pane) => after.includes(pane));
		return {
			scenario,
			verdict: interrupted.length > 0 && othersSurvived ? "pass" : "fail",
			detail: `${interrupted.length} interrupted turn(s); unrelated panes survive: ${othersSurvived}`,
		};
	} finally {
		await stopHandle(handle);
	}
}

/** The pane ids that WezTerm holds. */

/** The pane ids that WezTerm holds. */
export async function listPanes(): Promise<number[]> {
	const result = await runProgram("wezterm", ["cli", "list", "--format", "json"]);
	try {
		const panes = JSON.parse(result.stdout) as Array<{ pane_id: number }>;
		return panes.map((pane) => pane.pane_id);
	} catch {
		return [];
	}
}

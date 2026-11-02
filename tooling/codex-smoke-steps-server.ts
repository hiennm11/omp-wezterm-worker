/**
 * The steps of the Codex smoke test that read the app server of a worker.
 *
 * Each step prints one line through the function `report`. The module holds
 * the steps that watch the events of a worker of Codex.
 */

import { join } from "node:path";

import { connectAppServer, itemOf } from "./codex-smoke-client.ts";
import { configuredMcpServerNames, rolloutEventTimes } from "./codex-smoke-home.ts";
import { completedReportCount, identityOf, spawnIds, statusText } from "./codex-smoke-ledger.ts";
import { cancelWorker, delay, recordThread, report, type SmokeState, textOf } from "./codex-smoke-shared.ts";
import {
	REPORT_INSTRUCTION,
	STEP_NAMES,
	type SteerEventKind,
	steerEventOrder,
	steerOrderText,
} from "./codex-smoke-steps.ts";

/** The name of the MCP server of the report tool. */
const REPORT_SERVER = "wezterm_worker_report";

/**
 * Step 4: the app server of the worker lists the report server and the
 * servers of the user.
 */
export async function stepMcpServers(state: SmokeState): Promise<void> {
	/* The step starts its own worker, because a worker that ends closes its
	   own app server and its own panes. The app server of a worker must run
	   while the step reads the list of the MCP servers. */
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: "Wait for 600 seconds. Do not report anything.",
		cwd: state.repo,
		label: "codex-smoke-servers",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId) {
		report(state, "fail", STEP_NAMES.mcpServers, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	state.workersToCancel.push(ids.workerId);
	try {
		const identity = identityOf(state.stateDir, ids.workerId);
		recordThread(state, identity.threadId);
		if (identity.port === null) {
			report(state, "fail", STEP_NAMES.mcpServers, "the worker holds no port, so no app server answers");
			return;
		}
		const client = await connectAppServer(`ws://127.0.0.1:${identity.port}`).catch(() => null);
		if (!client) {
			report(
				state,
				"fail",
				STEP_NAMES.mcpServers,
				`the app server of the port ${identity.port} does not answer`,
			);
			return;
		}
		try {
			const list = await client.request("mcpServerStatus/list", { threadId: identity.threadId ?? "" });
			if (list.error) {
				report(
					state,
					"fail",
					STEP_NAMES.mcpServers,
					`the list of the MCP servers failed: ${list.error.message}`,
				);
				return;
			}
			const data = (list.result as { data?: Array<{ name?: string }> })?.data ?? [];
			const names = data.map((server) => server.name ?? "");
			if (!names.includes(REPORT_SERVER)) {
				report(
					state,
					"fail",
					STEP_NAMES.mcpServers,
					`the report server is not in the list: ${names.join(", ")}`,
				);
				return;
			}
			const configured = configuredMcpServerNames();
			const missing = configured.filter((name) => !names.includes(name));
			if (missing.length > 0) {
				report(
					state,
					"fail",
					STEP_NAMES.mcpServers,
					`the servers of the user are missing: ${missing.join(", ")}`,
				);
				return;
			}
			if (configured.length === 0) {
				report(
					state,
					"pass",
					STEP_NAMES.mcpServers,
					`the app server lists ${REPORT_SERVER}; the config of the user names no other MCP server`,
				);
				return;
			}
			report(
				state,
				"pass",
				STEP_NAMES.mcpServers,
				`the app server lists ${names.join(", ")}; the config of the user names ${configured.join(", ")}`,
			);
		} finally {
			client.close();
		}
	} finally {
		await cancelWorker(state, ids.workerId);
	}
}

/**
 * Step 5: the events of a steering instruction arrive in the order of the
 * contract.
 *
 * The step sends a steering instruction while a shell command of the worker
 * runs. It records the time of the answer of the steer tool, the time of the
 * event `turn/started`, the time of the delivery of the instruction and the
 * time of the first report.
 *
 * The app server sends the event `turn/started` only to the connections
 * that subscribed before the turn started. The rollout file of the thread
 * holds the time of every event of the turn, so the smoke test reads the
 * times there.
 */
export async function stepSteerOrder(state: SmokeState): Promise<void> {
	const spawned = await state.host.call("wezterm_spawn_worker", {
		task: `Run a shell command that waits 60 seconds. ${REPORT_INSTRUCTION}`,
		cwd: state.repo,
		label: "codex-smoke-steer",
		backend: "codex",
		placement: "tab",
	});
	const ids = spawnIds(spawned);
	if (!ids.workerId) {
		report(state, "fail", STEP_NAMES.steerOrder, `the spawn returned no worker id: ${textOf(spawned)}`);
		return;
	}
	state.workersToCancel.push(ids.workerId);
	const identity = identityOf(state.stateDir, ids.workerId);
	recordThread(state, identity.threadId);
	if (identity.port === null || !identity.threadId) {
		report(state, "fail", STEP_NAMES.steerOrder, "the worker holds no thread, so no observer can watch it");
		return;
	}
	const client = await connectAppServer(`ws://127.0.0.1:${identity.port}`).catch(() => null);
	if (!client) {
		report(state, "fail", STEP_NAMES.steerOrder, "the app server of the worker does not answer");
		return;
	}
	/* The app server sends the events of a thread only to the connections
	   that subscribed to it. The observer resumes the thread, so it sees the
	   items of the worker. */
	const resumed = await client.request("thread/resume", { threadId: identity.threadId });
	if (resumed.error) {
		client.close();
		report(
			state,
			"fail",
			STEP_NAMES.steerOrder,
			`the observer did not subscribe to the thread: ${resumed.error.message}`,
		);
		return;
	}

	const times: Partial<Record<SteerEventKind, number>> = {};
	try {
		const startDeadline = Date.now() + 60_000;
		while (Date.now() < startDeadline) {
			const read = rolloutEventTimes(identity.threadId, "");
			if (read.turnStarted !== null) {
				times["turn/started"] = read.turnStarted;
				break;
			}
			await delay(500);
		}

		const steered = await state.host.call("wezterm_worker_steer", {
			workerId: ids.workerId,
			message:
				"Reply with the word STEER-OK. Then find the tool wezterm_worker_report with ALL_TOOLS, " +
				"call it, and report the state completed with the result STEER-OK.",
		});
		times["steer answer"] = Date.now();
		const steerText = textOf(steered);
		if (!steerText.includes("Queued for worker")) {
			report(
				state,
				"fail",
				STEP_NAMES.steerOrder,
				`the steer tool refused the instruction: ${steerText.replace(/\n/g, " | ")}`,
			);
			return;
		}

		/* The delivery of the instruction is the item of the user message
		   that carries the client id of the instruction. The rollout file
		   holds the time of that item. */
		const deliveryDeadline = Date.now() + 120_000;
		let clientId: string | null = null;
		while (Date.now() < deliveryDeadline) {
			for (const message of client.messages) {
				if (message.method !== "item/started") continue;
				const item = itemOf(message);
				if (item?.type !== "userMessage") continue;
				if (typeof item.clientId !== "string" || item.clientId.length === 0) continue;
				clientId = item.clientId;
				break;
			}
			if (clientId !== null) {
				const read = rolloutEventTimes(identity.threadId, clientId);
				if (read.delivered !== null) {
					times["instruction delivered"] = read.delivered;
					break;
				}
			}
			await delay(500);
		}

		/* The worker must stay RUNNING until the instruction ran. The
		   status is read as soon as the delivery arrived. */
		const statusAtDelivery = await statusText(state, ids.workerId);
		const runningAtDelivery = statusAtDelivery.includes("RUNNING");

		const sessionDir = join(state.stateDir, "sessions", ids.workerId);
		const reportDeadline = Date.now() + 120_000;
		while (Date.now() < reportDeadline) {
			if (completedReportCount(sessionDir, ids.workerId) > 0) {
				times["first report"] = Date.now();
				break;
			}
			await delay(1000);
		}

		const verdict = steerEventOrder(times);
		const text = steerOrderText(times);
		if (verdict.missing.length > 0) {
			report(
				state,
				"fail",
				STEP_NAMES.steerOrder,
				`${text}; the worker stays ${runningAtDelivery ? "RUNNING" : "not RUNNING"} at the delivery`,
			);
			return;
		}
		if (!verdict.ordered) {
			report(state, "fail", STEP_NAMES.steerOrder, `${text}; the order breaks the contract`);
			return;
		}
		if (!runningAtDelivery) {
			report(
				state,
				"fail",
				STEP_NAMES.steerOrder,
				`${text}; the worker was not RUNNING when the instruction ran`,
			);
			return;
		}
		report(state, "pass", STEP_NAMES.steerOrder, text);
	} finally {
		client.close();
		await cancelWorker(state, ids.workerId);
	}
}

/**
 * wezterm_worker_facts
 *
 * The main session controls the store of the facts. It lists the promoted
 * facts, it writes a fact of its own, it promotes a proposed fact of a
 * worker, and it retracts a promoted fact.
 *
 * The promoted file lives in the state directory. Only the main session
 * writes it. The extension never removes it, because a promoted fact is a
 * work product.
 */

import { controlRefusal, refusalDetails } from "../lib/authority.ts";
import {
	factKeyRefusal,
	factTextRefusal,
	formatFacts,
	NO_SESSION_IDENTITY,
	RETRACTION_NOTICE,
} from "../lib/facts-model.ts";
import {
	appendPromotedFact,
	appendRetraction,
	promotedFactsFile,
	readPromotedFacts,
	readProposedFacts,
} from "../lib/facts-store.ts";
import type { ToolCtx } from "../lib/host.ts";
import { taskKey } from "../lib/owner.ts";
import { readOwnership } from "../lib/ownership.ts";
import type { WorkerRuntime } from "../lib/runtime.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

/** The actions that the tool accepts. */
const ACTIONS = ["list", "set", "promote", "retract"];

export function registerFactsTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_facts",
		label: "Facts Of The Main Session",
		description:
			"Manage the facts of the main session. " +
			"The action 'list' shows the promoted facts. " +
			"The action 'set' writes a fact that you name. " +
			"The action 'promote' copies a proposed fact of a worker. " +
			"The action 'retract' withdraws a promoted fact.",
		parameters: z.object({
			action: z.string().describe(`The action to take. One of: ${ACTIONS.join(", ")}.`),
			key: z.string().optional().describe("The key of the fact. Required for set, promote and retract."),
			text: z.string().optional().describe("The text of the fact. Required for set."),
			workerId: z
				.string()
				.optional()
				.describe("Id of the worker that proposed the fact. Required for promote."),
		}),
		loadMode: "essential",
		async execute(
			_toolCallId: string,
			params: { action?: string; key?: string; text?: string; workerId?: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx?: ToolCtx,
		) {
			const action = String(params.action ?? "");
			if (!ACTIONS.includes(action)) {
				return reply(`The action must be one of ${ACTIONS.join(", ")}.`, { action }, true);
			}
			if (!rt.sessionId) {
				return reply(NO_SESSION_IDENTITY, { action, refused: "session" }, true);
			}
			if (action === "list") {
				const facts = readPromotedFacts(rt.config.stateDir, rt.sessionId);
				return reply(formatFacts(facts), { action, count: facts.length, facts });
			}
			if (action === "set") return setFact(rt, params);
			if (action === "promote") return promoteFact(rt, params);
			return retractFact(rt, params);
		},
	});
}

/** Write a fact that the main session names itself. */
function setFact(rt: WorkerRuntime, params: { key?: string; text?: string }) {
	const key = String(params.key ?? "").trim();
	const text = String(params.text ?? "");
	const keyRefusal = factKeyRefusal(key);
	if (keyRefusal) return reply(keyRefusal, { action: "set", written: false }, true);
	const textRefusal = factTextRefusal(text);
	if (textRefusal) return reply(textRefusal, { action: "set", written: false }, true);
	const fact = appendPromotedFact(rt.config.stateDir, rt.sessionId as string, {
		key,
		text: text.trim(),
		writer: rt.sessionId as string,
		at: Date.now(),
	});
	return reply(`The fact '${fact.key}' is promoted.`, { action: "set", written: true, key: fact.key });
}

/** Copy a proposed fact of a worker into the promoted file. */
function promoteFact(rt: WorkerRuntime, params: { key?: string; workerId?: string }) {
	const key = String(params.key ?? "").trim();
	const keyRefusal = factKeyRefusal(key);
	if (keyRefusal) return reply(keyRefusal, { action: "promote", promoted: false }, true);
	const found = findJob(rt, String(params.workerId ?? ""));
	if ("error" in found) return found.error;
	const job = found.job;
	const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
	const authorityRefusal = controlRefusal(owner, rt.sessionId, job.id);
	if (authorityRefusal) {
		return reply(authorityRefusal, { ...refusalDetails(job.id, owner), refused: "authority" }, true);
	}
	const proposed = readProposedFacts(job.sessionDir).find((fact) => fact.key === key);
	if (!proposed) {
		return reply(
			`The worker ${job.id} proposed no fact with the key '${key}'.`,
			{ action: "promote", promoted: false, key },
			true,
		);
	}
	const fact = appendPromotedFact(rt.config.stateDir, rt.sessionId as string, {
		key: proposed.key,
		text: proposed.text,
		writer: proposed.writer,
		at: Date.now(),
	});
	return reply(`The fact '${fact.key}' of worker ${job.id} is promoted.`, {
		action: "promote",
		promoted: true,
		key: fact.key,
		workerId: job.id,
	});
}

/** Withdraw a promoted fact. */
function retractFact(rt: WorkerRuntime, params: { key?: string }) {
	const key = String(params.key ?? "").trim();
	const keyRefusal = factKeyRefusal(key);
	if (keyRefusal) return reply(keyRefusal, { action: "retract", retracted: false }, true);
	const fact = appendRetraction(rt.config.stateDir, rt.sessionId as string, {
		key,
		writer: rt.sessionId as string,
		at: Date.now(),
	});
	if (!fact) {
		return reply(
			`The store holds no fact with the key '${key}'.`,
			{ action: "retract", retracted: false, key },
			true,
		);
	}
	return reply(`The fact '${key}' is retracted. ${RETRACTION_NOTICE}`, {
		action: "retract",
		retracted: true,
		key,
		file: promotedFactsFile(rt.config.stateDir, rt.sessionId as string),
	});
}

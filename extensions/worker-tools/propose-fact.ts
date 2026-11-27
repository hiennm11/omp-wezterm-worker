/**
 * wezterm_worker_propose_fact
 *
 * The worker proposes a fact. The proposal waits in the session directory of
 * the worker. Only the main session promotes it, so a proposed fact changes
 * nothing for another worker.
 *
 * The tool is worker-only. The worker has no tool to read facts.
 */

import { factKeyRefusal, factTextRefusal } from "../lib/facts-model.ts";
import { appendProposedFact } from "../lib/facts-store.ts";
import type { ToolCtx } from "../lib/host.ts";
import { readRunContext } from "../lib/worker-context.ts";
import { reply, type ToolDeps } from "./kit.ts";
import { workerSessionDir } from "./worker-channel.ts";

export function registerProposeFactTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	rt.registerWorkerTool({
		name: "wezterm_worker_propose_fact",
		label: "Propose A Fact",
		description:
			"Propose a fact to the main session. " +
			"The fact waits in your session directory until the main session promotes it. " +
			"A proposed fact changes nothing for another worker.",
		parameters: z.object({
			key: z.string().describe("The key of the fact. A short name that is unique in the store."),
			text: z.string().describe("The text of the fact. At most 4000 characters."),
		}),
		loadMode: "essential",
		async execute(
			_toolCallId: string,
			params: { key?: string; text?: string },
			_signal?: unknown,
			_onUpdate?: unknown,
			_ctx?: ToolCtx,
		) {
			const sessionDir = workerSessionDir();
			if (!sessionDir) {
				return reply(
					"This process is not a worker. Only a worker proposes a fact.",
					{ proposed: false },
					true,
				);
			}
			const context = readRunContext(sessionDir);
			if (!context) {
				return reply(
					"The run context is missing. The worker was not launched by this extension.",
					{ proposed: false },
					true,
				);
			}
			const key = String(params.key ?? "").trim();
			const text = String(params.text ?? "");
			const keyRefusal = factKeyRefusal(key);
			if (keyRefusal) return reply(keyRefusal, { proposed: false }, true);
			const textRefusal = factTextRefusal(text);
			if (textRefusal) return reply(textRefusal, { proposed: false }, true);
			const fact = appendProposedFact(sessionDir, {
				key,
				text: text.trim(),
				writer: context.runId,
				at: Date.now(),
			});
			return reply(`The fact '${fact.key}' is proposed. The main session promotes it.`, {
				proposed: true,
				key: fact.key,
				runId: context.runId,
			});
		},
	});
}

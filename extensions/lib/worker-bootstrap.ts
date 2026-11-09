/**
 * The worker bootstrap.
 *
 * A worker process loads this extension. It must get the report tool and the
 * channel tools, and nothing else. It must not restore a monitor. It must not
 * deliver the events of the main session. It must not open the lifecycle
 * database.
 */

import type { ExtensionAPI } from "./host.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Give a worker process its tools.
 *
 * The worker reports the state of its own task and exchanges notes with the
 * main session. The owner reads the report and the notes. The worker never
 * supervises another worker.
 */
export function registerWorkerBootstrap(rt: WorkerRuntime, pi?: ExtensionAPI): void {
	// The report tool registers itself with the host. The channel tools
	// register with the runtime, and the bootstrap exposes them to the host.
	if (pi) {
		for (const tool of rt.workerTools.values()) {
			pi.registerTool({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				loadMode: tool.loadMode,
				execute: tool.execute,
			});
		}
	}
	// The bootstrap only marks the role, so that a worker never restores a
	// monitor.
	rt.role = "worker";
}

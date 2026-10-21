/**
 * The worker bootstrap.
 *
 * A worker process loads this extension. It must get the report tool and
 * nothing else. It must not restore a monitor. It must not deliver the
 * events of the main session. It must not open the lifecycle database.
 */

import type { WorkerRuntime } from "./runtime.ts";

/**
 * Give a worker process its tools.
 *
 * The worker reports the state of its own task. The owner reads the report.
 * The worker never supervises another worker.
 */
export function registerWorkerBootstrap(rt: WorkerRuntime): void {
	// The report tool registers itself with the host. The bootstrap only
	// marks the role, so that a worker never restores a monitor.
	rt.role = "worker";
}

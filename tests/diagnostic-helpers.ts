export interface WorkerDiagnostic {
	workerId: string;
	status: string;
	error: string | null;
	paneState: string;
}

export function workerDiagnostics(workers: readonly WorkerDiagnostic[]): string {
	return workers.map((worker) => `${worker.workerId}: status=${worker.status}, error=${worker.error ?? "(none)"}, paneState=${worker.paneState}`).join("\n");
}

export function worktreeDiagnostics(status: string, error: string | null, gitStatus: string): string {
	return [`worker status=${status}, error=${error ?? "(none)"}`, `git status --porcelain:\n${gitStatus || "(clean)"}`].join("\n");
}

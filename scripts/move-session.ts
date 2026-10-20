/**
 * Move the running OMP session into another working directory.
 *
 * Loaded with `omp --resume <file> -e <this file>`. The target directory comes
 * from the OMP_MOVE_TARGET environment variable.
 *
 * Why this exists: the interactive `/move` command needs a confirmation picker,
 * and `wezterm cli send-text` cannot deliver the Enter key. A session file that
 * a live process owns also cannot be packed or moved by another process
 * ("another live omp process writes this session"). So the only scriptable
 * route is to resume the transcript in a fresh process and move it from there.
 *
 * The move is performed by the documented SessionManager.moveTo(cwd), which
 * relocates the transcript into the target project's session bucket, updates
 * the header cwd and moves the artifacts directory.
 */

export default function moveSessionExtension(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void;
	logger: { info: (message: string) => void };
}) {
	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		const target = process.env.OMP_MOVE_TARGET;
		if (!target) {
			console.error("MOVE_ERROR no OMP_MOVE_TARGET set");
			return;
		}
		const session = ctx as {
			cwd: string;
			sessionManager: {
				moveTo: (cwd: string, sessionDir?: string) => unknown;
				getSessionFile?: () => string;
				ensureOnDisk?: () => void;
				flushSync?: () => void;
			};
		};
		const sm = session.sessionManager;

		// A lazy session has no transcript yet, so the move would have nothing
		// to relocate.
		sm.ensureOnDisk?.();
		await new Promise(resolve => setTimeout(resolve, 800));
		sm.flushSync?.();

		const before = sm.getSessionFile?.() ?? "(unknown)";
		console.error("MOVE_BEFORE " + before);

		try {
			const result = sm.moveTo(target);
			console.error("MOVE_RESULT " + JSON.stringify(result ?? null));
		} catch (e) {
			console.error("MOVE_ERROR " + String(e));
			return;
		}

		await new Promise(resolve => setTimeout(resolve, 2500));
		console.error("MOVE_AFTER " + (sm.getSessionFile?.() ?? "(unknown)"));
		console.error("MOVE_CWD " + session.cwd);
	});
}

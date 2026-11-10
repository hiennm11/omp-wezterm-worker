/**
 * The fake of the WezTerm CLI for the tests.
 *
 * The extension calls WezTerm through the seam `rt.wezterm`. The fake answers
 * the verbs of `wezterm cli` that the extension uses: the pane list, the
 * split, the spawn, the send-text, the get-text, the kill-pane and the
 * set-tab-title.
 *
 * The fake holds a list of panes. Every pane has the number of WezTerm, such
 * as `7`. The fake keeps the shape of the replies of the CLI, so a test that
 * checks a reply checks the real shape.
 */

/** A pane of the fake. */
export interface FakePane {
	/** The id of the pane, such as `7`. */
	paneId: number;
	/** The id of the tab of the pane, such as `1`. */
	tabId: number;
	/** The id of the window of the pane, such as `0`. */
	windowId: number;
}

/** The options of the fake. */
export interface WeztermFakeOptions {
	/** The panes that the fake holds. */
	panes?: FakePane[];
	/** The exit code of the pane list. A code other than zero hides the list. */
	listCode?: number;
	/** The pane list answers with a reply that holds no pane list. */
	brokenList?: boolean;
	/** The split fails. */
	failSplit?: boolean;
	/** The spawn fails. */
	failSpawn?: boolean;
	/** The send-text fails. */
	failSendText?: boolean;
	/** The get-text fails. */
	failGetText?: boolean;
	/** The kill-pane fails. */
	failKillPane?: boolean;
	/** The id of the next pane that the fake opens. */
	nextPane?: number;
}

/** The state of the fake. */
export interface WeztermFake {
	/** The calls that the fake received. */
	calls: string[][];
	/** The panes that the fake holds now. */
	panes: Set<string>;
	/** The ids of the panes that the fake closed. */
	closed: string[];
	/** The texts that the fake received through the send-text. */
	sends: string[];
	/** The programs that the fake started. */
	started: string[][];
	/** The answer of the fake for one call. */
	answer: (args: string[]) => { code: number; stdout: string; stderr: string };
}

/**
 * The reply of the pane list of the fake.
 *
 * The reply of `wezterm cli list --format json` is a list of panes. Every
 * pane holds the number of the pane, the number of the tab and the number of
 * the window.
 */
export function paneListReply(panes: readonly FakePane[]): string {
	return JSON.stringify(
		panes.map((pane) => ({
			pane_id: pane.paneId,
			tab_id: pane.tabId,
			window_id: pane.windowId,
		})),
	);
}

/**
 * Build the fake of the WezTerm CLI.
 *
 * The function returns the answers of the CLI and the state that the test
 * reads. The signature of the fake stays `(args, env) => RunResult`.
 */
export function weztermFake(options: WeztermFakeOptions = {}): WeztermFake {
	/* The extension refuses a spawn outside a pane runtime. A test that fakes
	   WezTerm stands for a session, so the variable is set here. */
	process.env.WEZTERM_PANE = "1";
	const state: WeztermFake = {
		calls: [],
		panes: new Set<string>(),
		closed: [],
		sends: [],
		started: [],
		answer: () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const counter = { next: options.nextPane ?? 100 };
	for (const pane of options.panes ?? []) state.panes.add(String(pane.paneId));

	const answer = (args: string[]): { code: number; stdout: string; stderr: string } => {
		state.calls.push(args);
		if (args[0] === "list") {
			if (options.listCode !== undefined && options.listCode !== 0) {
				return { code: options.listCode, stdout: "", stderr: "" };
			}
			if (options.brokenList) return { code: 0, stdout: "not json", stderr: "" };
			const panes = [...state.panes].map((paneId) => ({
				paneId: Number(paneId),
				tabId: 1,
				windowId: 0,
			}));
			return { code: 0, stdout: paneListReply(panes), stderr: "" };
		}
		if (args[0] === "split-pane") {
			if (options.failSplit) return { code: 1, stdout: "", stderr: "the split failed" };
			const paneId = counter.next;
			counter.next += 1;
			state.panes.add(String(paneId));
			recordStart(state, args);
			return { code: 0, stdout: String(paneId), stderr: "" };
		}
		if (args[0] === "spawn") {
			if (options.failSpawn) return { code: 1, stdout: "", stderr: "the spawn failed" };
			const paneId = counter.next;
			counter.next += 1;
			state.panes.add(String(paneId));
			recordStart(state, args);
			return { code: 0, stdout: String(paneId), stderr: "" };
		}
		if (args[0] === "send-text") {
			if (options.failSendText) return { code: 1, stdout: "", stderr: "the send failed" };
			const at = args.indexOf("--pane-id");
			state.sends.push(args[at + 2] ?? "");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "get-text") {
			if (options.failGetText) return { code: 1, stdout: "", stderr: "the read failed" };
			return { code: 0, stdout: "bypass permissions on", stderr: "" };
		}
		if (args[0] === "kill-pane") {
			if (options.failKillPane) return { code: 1, stdout: "", stderr: "the kill failed" };
			const at = args.indexOf("--pane-id");
			const paneId = args[at + 1] ?? "";
			state.panes.delete(paneId);
			state.closed.push(paneId);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "set-tab-title") return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	state.answer = answer;
	return state;
}

/**
 * The program that a split or a spawn started.
 *
 * The program is the element after `--`. The fake records it, so a test can
 * see the argv of the worker.
 */
function recordStart(state: WeztermFake, args: string[]): void {
	const dash = args.indexOf("--");
	state.started.push(dash < 0 ? [] : args.slice(dash + 1));
}

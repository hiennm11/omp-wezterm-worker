/**
 * The fake of the Herdr CLI for the tests.
 *
 * The extension calls Herdr through the seam `rt.herdr`. The fake answers
 * the verbs of Herdr that the extension uses: the pane list, the split, the
 * tab creation, the agent start, the agent prompt, the pane read, the pane
 * close and the tab rename.
 *
 * The fake holds a list of panes. Every pane has the id of Herdr, such as
 * `w1:p7`. The fake keeps the shape of the replies of Herdr, so a test that
 * checks a reply checks the real shape.
 */

/** A pane of the fake. */
export interface FakePane {
	/** The id of the pane, such as `w1:p7`. */
	paneId: string;
	/** The id of the tab of the pane, such as `w1:t1`. */
	tabId: string;
}

/** The options of the fake. */
export interface HerdrFakeOptions {
	/** The panes that the fake holds. */
	panes?: FakePane[];
	/** The exit code of the pane list. A code other than zero hides the list. */
	listCode?: number;
	/** The pane list answers with a reply that holds no pane list. */
	brokenList?: boolean;
	/** The agent start fails. */
	failAgentStart?: boolean;
	/** The agent prompt fails. */
	failAgentPrompt?: boolean;
	/** The pane read fails. */
	failPaneRead?: boolean;
	/** The pane close fails. */
	failPaneClose?: boolean;
	/** The tab creation fails. */
	failTabCreate?: boolean;
	/** The pane split fails. */
	failSplit?: boolean;
	/** The id of the next pane that the fake opens. */
	nextPane?: number;
}

/** The state of the fake. */
export interface HerdrFake {
	/** The calls that the fake received. */
	calls: string[][];
	/** The panes that the fake holds now. */
	panes: Set<string>;
	/** The ids of the panes that the fake closed. */
	closed: string[];
	/** The texts that the fake received through the agent prompt. */
	prompts: string[];
	/** The programs that the fake started through the agent start. */
	started: string[][];
	/** The answer of the fake for one call. */
	answer: (args: string[]) => { code: number; stdout: string; stderr: string };
}

/** The id of the next pane of the fake. */
function nextPaneId(state: { next: number }): string {
	const paneId = `w1:p${state.next}`;
	state.next += 1;
	return paneId;
}

/**
 * The reply of a pane of the fake.
 *
 * The reply holds the pane under `result.pane`, like the reply of a split.
 */
export function paneReply(pane: FakePane): string {
	return JSON.stringify({ result: { pane: { pane_id: pane.paneId, tab_id: pane.tabId } } });
}

/**
 * Build the fake of the Herdr CLI.
 *
 * The function returns the answers of the CLI and the state that the test
 * reads. The signature of the fake stays `(args, env) => RunResult`.
 */
export function herdrFake(options: HerdrFakeOptions = {}): HerdrFake {
	/* The extension refuses a spawn outside a Herdr session. A test that
	   fakes Herdr stands for a session, so the variable is set here. */
	process.env.HERDR_ENV = "1";
	const state: HerdrFake = {
		calls: [],
		panes: new Set<string>(),
		closed: [],
		prompts: [],
		started: [],
		answer: () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const counter = { next: options.nextPane ?? 100 };
	for (const pane of options.panes ?? []) state.panes.add(pane.paneId);

	const answer = (args: string[]): { code: number; stdout: string; stderr: string } => {
		state.calls.push(args);
		if (args[0] === "pane" && args[1] === "list") {
			if (options.listCode !== undefined && options.listCode !== 0) {
				return { code: options.listCode, stdout: "", stderr: "" };
			}
			if (options.brokenList) return { code: 0, stdout: "not json", stderr: "" };
			const panes = [...state.panes].map((pane_id) => ({ pane_id, tab_id: "w1:t1" }));
			return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "split") {
			if (options.failSplit) return { code: 1, stdout: "", stderr: "the split failed" };
			const pane = { paneId: nextPaneId(counter), tabId: "w1:t1" };
			state.panes.add(pane.paneId);
			return { code: 0, stdout: paneReply(pane), stderr: "" };
		}
		if (args[0] === "tab" && args[1] === "create") {
			if (options.failTabCreate) return { code: 1, stdout: "", stderr: "the tab failed" };
			const pane = { paneId: nextPaneId(counter), tabId: `w1:t${counter.next}` };
			state.panes.add(pane.paneId);
			return {
				code: 0,
				stdout: JSON.stringify({ result: { root_pane: { pane_id: pane.paneId, tab_id: pane.tabId } } }),
				stderr: "",
			};
		}
		if (args[0] === "agent" && args[1] === "start") {
			if (options.failAgentStart) return { code: 1, stdout: "", stderr: "the agent did not start" };
			const dash = args.indexOf("--");
			state.started.push(dash < 0 ? [] : args.slice(dash + 1));
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (args[0] === "agent" && args[1] === "prompt") {
			if (options.failAgentPrompt) return { code: 1, stdout: "", stderr: "the prompt failed" };
			state.prompts.push(args.slice(3).join(" "));
			return { code: 0, stdout: JSON.stringify({ result: { agent: {} } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "read") {
			if (options.failPaneRead) return { code: 1, stdout: "", stderr: "the read failed" };
			return { code: 0, stdout: "bypass permissions on", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "close") {
			if (options.failPaneClose) return { code: 1, stdout: "", stderr: "the close failed" };
			const paneId = args[2] ?? "";
			state.panes.delete(paneId);
			state.closed.push(paneId);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "tab" && args[1] === "rename") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "layout:apply") {
			const pane = { paneId: nextPaneId(counter), tabId: `w1:t${counter.next}` };
			state.panes.add(pane.paneId);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { layout: { root: { pane_id: pane.paneId, tab_id: pane.tabId } } },
				}),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	state.answer = answer;
	return state;
}

/**
 * The four scenarios of the Windows trial.
 *
 * Each scenario starts one real worker, waits for it and turns what it saw
 * into checks. A scenario never throws: a failure becomes a check that did
 * not pass, so one broken scenario does not stop the others.
 */

import { currentPanes, detailBoolean, type TestHost } from "../tests/harness.ts";
import type { ScenarioResult, TrialCheck } from "./trial-report.ts";
import {
	changedPaths,
	checkOtherPanes,
	checkPaneGone,
	checkUsage,
	commonChecks,
	deliveryDetail,
	notStarted,
	readRow,
	runCommand,
	scenarioResult,
	startWorker,
	waitForDelivery,
	waitForEnd,
	waitForTurn,
} from "./trial-scenario.ts";
import { FIX_TASK, LONG_TASK, SURVEY_TASK, TRIAL_MODEL } from "./trial-tasks.ts";

/** The survey worker reads the fixture and changes nothing. */
export async function surveyScenario(host: TestHost, fixture: string): Promise<ScenarioResult> {
	const start = Date.now();
	const checks: TrialCheck[] = [];
	const spawn = await startWorker(host, {
		task: SURVEY_TASK,
		cwd: fixture,
		label: "trial survey",
		model: TRIAL_MODEL,
	});
	if (spawn.workerId === null) {
		return notStarted(
			"Survey",
			SURVEY_TASK,
			spawn.refusal ?? "the spawn returned no worker id",
			Date.now() - start,
		);
	}
	const row = await waitForEnd(host, spawn.workerId, 300_000);
	const delivery = await waitForDelivery(host, spawn.workerId, 20_000);
	checks.push({
		name: "the worker completed",
		pass: row.status === "completed",
		detail: `the status is ${row.status ?? "unknown"}`,
	});
	checks.push({
		name: "the answer names both functions",
		pass: delivery !== null && /\badd\b/.test(delivery) && /\bsubtract\b/.test(delivery),
		detail: delivery === null ? "no result was delivered" : `the delivery says: ${deliveryDetail(delivery)}`,
	});
	const status = runCommand("git", ["status", "--porcelain"], fixture);
	checks.push({
		name: "no file changed",
		pass: status.code === 0 && status.output.trim() === "",
		detail:
			status.output.trim() === "" ? "the fixture is unchanged" : `git status says: ${status.output.trim()}`,
	});
	await commonChecks(spawn.paneId, row, delivery, checks);
	return scenarioResult("Survey", SURVEY_TASK, spawn.workerId, row, Date.now() - start, checks);
}

/** The fix worker repairs the bug of the fixture in an isolated worktree. */
export async function fixScenario(host: TestHost, fixture: string): Promise<ScenarioResult> {
	const start = Date.now();
	const checks: TrialCheck[] = [];
	const before = runCommand("node", ["--test", "test/math.test.mjs"], fixture);
	checks.push({
		name: "the test fails before the fix",
		pass: before.code !== 0,
		detail: `the test run ended with code ${before.code}`,
	});
	const spawn = await startWorker(host, {
		task: FIX_TASK,
		cwd: fixture,
		label: "trial fix",
		model: TRIAL_MODEL,
		isolated: true,
		timeoutMs: 600_000,
	});
	if (spawn.workerId === null) {
		return notStarted(
			"Fix with a test",
			FIX_TASK,
			spawn.refusal ?? "the spawn returned no worker id",
			Date.now() - start,
		);
	}
	const row = await waitForEnd(host, spawn.workerId, 600_000);
	const delivery = await waitForDelivery(host, spawn.workerId, 20_000);
	checks.push({
		name: "the worker completed",
		pass: row.status === "completed",
		detail: `the status is ${row.status ?? "unknown"}`,
	});
	const worktree = spawn.worktreePath;
	if (worktree === null) {
		const detail = "the spawn returned no worktree path";
		checks.push({ name: "the test passes after the fix", pass: false, detail });
		checks.push({ name: "only src/math.mjs changed", pass: false, detail });
		checks.push({ name: "the test file is unchanged", pass: false, detail });
	} else {
		const after = runCommand("node", ["--test", "test/math.test.mjs"], worktree);
		checks.push({
			name: "the test passes after the fix",
			pass: after.code === 0,
			detail: `the test run ended with code ${after.code}. ${after.lastLine}`,
		});
		const changed = changedPaths(worktree, "main");
		checks.push({
			name: "only src/math.mjs changed",
			pass: changed.length === 1 && changed[0] === "src/math.mjs",
			detail: `the changed paths are: ${changed.join(", ") || "(none)"}`,
		});
		const testFile = runCommand("git", ["diff", "--quiet", "main", "--", "test/math.test.mjs"], worktree);
		checks.push({
			name: "the test file is unchanged",
			pass: testFile.code === 0,
			detail: `git diff ended with code ${testFile.code}`,
		});
	}
	await commonChecks(spawn.paneId, row, delivery, checks);
	return scenarioResult("Fix with a test", FIX_TASK, spawn.workerId, row, Date.now() - start, checks);
}

/** The timeout worker runs past its deadline and must be stopped. */
export async function timeoutScenario(host: TestHost, fixture: string): Promise<ScenarioResult> {
	const start = Date.now();
	const checks: TrialCheck[] = [];
	const panesBefore = currentPanes();
	const spawn = await startWorker(host, {
		task: LONG_TASK,
		cwd: fixture,
		label: "trial timeout",
		model: TRIAL_MODEL,
		timeoutMs: 30_000,
	});
	if (spawn.workerId === null) {
		return notStarted(
			"Timeout",
			LONG_TASK,
			spawn.refusal ?? "the spawn returned no worker id",
			Date.now() - start,
		);
	}
	const row = await waitForEnd(host, spawn.workerId, 120_000);
	checks.push({
		name: "the worker failed at its deadline",
		pass: row.status === "failed" && /timed out/.test(row.error ?? ""),
		detail: `the status is ${row.status ?? "unknown"} and the error is: ${row.error ?? "(none)"}`,
	});
	checks.push({
		name: "the stop was confirmed",
		pass: row.stop === null,
		detail: row.stop === null ? "the status row holds no pending stop" : `the status row says: ${row.stop}`,
	});
	const delivery = await waitForDelivery(host, spawn.workerId, 20_000);
	checks.push({
		name: "the result was delivered",
		pass: delivery !== null,
		detail: deliveryDetail(delivery),
	});
	const pane = await checkPaneGone(spawn.paneId);
	checks.push({ name: "the pane is gone", pass: pane.pass, detail: pane.detail });
	const other = checkOtherPanes(panesBefore, spawn.paneId);
	checks.push({ name: "no other pane closed", pass: other.pass, detail: other.detail });
	return scenarioResult("Timeout", LONG_TASK, spawn.workerId, row, Date.now() - start, checks);
}

/** The cancel worker is stopped by the main agent while it works. */
export async function cancelScenario(host: TestHost, fixture: string): Promise<ScenarioResult> {
	const start = Date.now();
	const checks: TrialCheck[] = [];
	const panesBefore = currentPanes();
	const spawn = await startWorker(host, {
		task: LONG_TASK,
		cwd: fixture,
		label: "trial cancel",
		model: TRIAL_MODEL,
	});
	if (spawn.workerId === null) {
		return notStarted(
			"Cancel",
			LONG_TASK,
			spawn.refusal ?? "the spawn returned no worker id",
			Date.now() - start,
		);
	}
	const started = await waitForTurn(host, spawn.workerId, 90_000);
	checks.push({
		name: "the worker started work",
		pass: (started.turns ?? 0) >= 1,
		detail: `the worker did ${started.turns ?? 0} turn(s)`,
	});
	const cancelled = await host.call("wezterm_worker_cancel", { workerId: spawn.workerId });
	checks.push({
		name: "the cancel was confirmed",
		pass: detailBoolean(cancelled.details, "stopped") === true,
		detail: host.text(cancelled),
	});
	const row = await readRow(host, spawn.workerId);
	checks.push({
		name: "the worker is cancelled",
		pass: row.status === "cancelled",
		detail: `the status is ${row.status ?? "unknown"}`,
	});
	const pane = await checkPaneGone(spawn.paneId);
	checks.push({ name: "the pane is gone", pass: pane.pass, detail: pane.detail });
	const other = checkOtherPanes(panesBefore, spawn.paneId);
	checks.push({ name: "no other pane closed", pass: other.pass, detail: other.detail });
	const usage = checkUsage(row.usage);
	checks.push({ name: "usage was measured", pass: usage.pass, detail: usage.detail });
	return scenarioResult("Cancel", LONG_TASK, spawn.workerId, row, Date.now() - start, checks);
}

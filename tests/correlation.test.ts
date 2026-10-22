import assert from "node:assert/strict";
import { test } from "node:test";

import { jobIdOfCommandLine, nativeJobIdOfCommandLine, workersOf } from "../extensions/lib/correlation.ts";

test("the job id of an omp command line is the name of its session directory", () => {
	const line = '"C:\\omp.exe" --no-title --cwd D:\\work --session-dir C:\\state\\sessions\\wz-abc123';
	assert.equal(jobIdOfCommandLine(line), "wz-abc123");
});

test("a command line without a session directory names no worker", () => {
	assert.equal(jobIdOfCommandLine('"C:\\omp.exe" --version'), null);
});

test("the job id of a native command line is the name of its session directory", () => {
	const line =
		"C:\\Users\\Admin\\.local\\bin\\claude.EXE --session-id 1111 --plugin-dir " +
		"C:\\Users\\Admin\\AppData\\Local\\Temp\\state\\sessions\\wz-native1\\claude-plugin --model haiku";
	assert.equal(nativeJobIdOfCommandLine(line), "wz-native1");
});

test("a native command line without a plugin names no worker", () => {
	assert.equal(nativeJobIdOfCommandLine("claude.exe --session-id 1111 --model haiku"), null);
});

test("the process table holds an omp worker and a native worker", () => {
	const workers = workersOf([
		{
			processId: 1,
			commandLine: '"C:\\omp.exe" --session-dir C:\\state\\sessions\\wz-omp1',
		},
		{
			processId: 2,
			commandLine: "claude.EXE --plugin-dir C:\\state\\sessions\\wz-native1\\claude-plugin",
		},
		{ processId: 3, commandLine: "notepad.exe" },
	]);
	assert.deepEqual(workers.map((w) => w.jobId).sort(), ["wz-native1", "wz-omp1"]);
});

test("the process table holds one row per worker", () => {
	const workers = workersOf([
		{
			processId: 1,
			commandLine: "claude.EXE --plugin-dir C:\\state\\sessions\\wz-native1\\claude-plugin",
		},
		{
			processId: 2,
			commandLine: "claude.EXE --plugin-dir C:\\state\\sessions\\wz-native1\\claude-plugin --model haiku",
		},
	]);
	assert.equal(workers.length, 1);
});

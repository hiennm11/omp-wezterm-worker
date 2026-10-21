import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const MAX_LINES = 350;
const SOURCE_DIRS = ["extensions", "tooling", "tests", "scripts"];

/** Every TypeScript file under the directory, as a path relative to the root. */
function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) found.push(path.replace(/\\/g, "/"));
	}
	return found;
}

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

/** The module specifiers a file imports. */
function importsOf(path: string): string[] {
	const source = read(path);
	const named = source.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm);
	const bare = source.matchAll(/^import\s+"([^"]+)"/gm);
	return [...named, ...bare].map((m) => m[1]);
}

test(`no source file is longer than ${MAX_LINES} lines`, () => {
	const tooLong = SOURCE_DIRS.flatMap(sourceFiles)
		.map((path) => ({ path, lines: read(path).split("\n").length }))
		.filter((file) => file.lines > MAX_LINES)
		.map((file) => `${file.path} (${file.lines})`);
	assert.deepEqual(tooLong, [], "Split these files by responsibility.");
});

test("lib never imports from the entry or from worker-tools", () => {
	const upward = sourceFiles("extensions/lib").flatMap((path) =>
		importsOf(path)
			.filter((spec) => spec.includes("worker-tools") || /wezterm-worker(\.ts)?$/.test(spec))
			.map((spec) => `${path} imports ${spec}`),
	);
	assert.deepEqual(upward, []);
});

test("only lib/process.ts starts a child process", () => {
	const offenders = sourceFiles("extensions")
		.filter((path) => path !== "extensions/lib/process.ts")
		.filter((path) => importsOf(path).includes("node:child_process"))
		.map((path) => relative(".", path));
	assert.deepEqual(offenders, [], "Run programs through rt.exec, rt.wezterm or rt.git.");
});

test("worker-tools modules do not read the module-level runtime", () => {
	const offenders = sourceFiles("extensions/worker-tools").filter((path) =>
		/\bcreateRuntime\b/.test(read(path)),
	);
	assert.deepEqual(offenders, [], "A tool receives the runtime through ToolDeps.");
});

test("the entry holds the only runtime", () => {
	const creators = sourceFiles("extensions")
		.filter((path) => path !== "extensions/lib/runtime.ts")
		.filter((path) => /\bcreateRuntime\(/.test(read(path)));
	assert.deepEqual(creators, ["extensions/wezterm-worker.ts"]);
});

/**
 * The directory names that OMP scans inside a plugin package.
 *
 * OMP loads every module of these directories as a custom tool. A script that
 * is not a tool must not live there, because OMP runs it at load time.
 */
const OMP_SCANNED_DIRS = ["tools", "commands", "rules", "prompts", "agents", "hooks"];

test("no script sits in a directory that OMP scans as a tool", () => {
	const offenders = OMP_SCANNED_DIRS.filter((dir) => existsSync(join(ROOT, dir))).map(
		(dir) => `${dir}/ holds ${sourceFiles(dir).join(", ")}`,
	);
	assert.deepEqual(
		offenders,
		[],
		"OMP imports every module of these directories as a custom tool. Move the scripts to tooling/ or scripts/.",
	);
});

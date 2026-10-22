import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearHandover, readHandover, writeHandover } from "../extensions/lib/bridge-handover.ts";

test("a handover names the bridge of the current owner", () => {
	const dir = mkdtempSync(join(tmpdir(), "wz-handover-"));
	try {
		writeHandover(dir, { url: "http://127.0.0.1:1234", token: "secret" });
		const found = readHandover(dir);
		assert.equal(found?.url, "http://127.0.0.1:1234");
		assert.equal(found?.token, "secret");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a new owner replaces the handover of the old one", () => {
	const dir = mkdtempSync(join(tmpdir(), "wz-handover-"));
	try {
		writeHandover(dir, { url: "http://127.0.0.1:1", token: "old" });
		writeHandover(dir, { url: "http://127.0.0.1:2", token: "new" });
		const found = readHandover(dir);
		assert.equal(found?.url, "http://127.0.0.1:2");
		assert.equal(found?.token, "new");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a released owner leaves no handover", () => {
	const dir = mkdtempSync(join(tmpdir(), "wz-handover-"));
	try {
		writeHandover(dir, { url: "http://127.0.0.1:1", token: "old" });
		clearHandover(dir);
		assert.equal(readHandover(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a missing handover gives null", () => {
	const dir = mkdtempSync(join(tmpdir(), "wz-handover-"));
	try {
		assert.equal(readHandover(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { createDeliver } from "../extensions/lib/deliver.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { RUNTIME, createHost, sessionContext } from "./harness.ts";
import { makeJob } from "./takeover-helpers.ts";

const cwd = process.cwd();

async function verifyChannelOwner(firstAgent: { id: string; kind: "main" | "sub" }, secondAgent: { id: string; kind: "main" | "sub" }) {
	const first = createHost({ cwd, agent: firstAgent });
	const second = createHost({ cwd, agent: secondAgent });
	try {
		await first.fire("session_start", sessionContext(cwd, "session-first", firstAgent));
		await second.fire("session_start", sessionContext(cwd, "session-second", secondAgent));
		RUNTIME.sendToMainSession("channel-text");
		const main = firstAgent.kind === "main" ? first : second;
		const sub = firstAgent.kind === "sub" ? first : second;
		assert.deepEqual(main.delivered, ["channel-text"]);
		assert.deepEqual(sub.delivered, []);
	} finally {
		await first.cleanup();
		await second.cleanup();
	}
}

test("the main session owns the channel when its factory run comes first", async () => {
	await verifyChannelOwner({ id: "main", kind: "main" }, { id: "sub", kind: "sub" });
});

test("the main session owns the channel when its factory run comes second", async () => {
	await verifyChannelOwner({ id: "sub", kind: "sub" }, { id: "main", kind: "main" });
});

test("createDeliver sends to the runtime channel instead of the factory host", () => {
	const rt = createRuntime();
	const delivered: string[] = [];
	const job = makeJob(rt.config.stateDir, "wz-channel");
	rt.sendToMainSession = (text) => {
		delivered.push(text);
		return "sendUserMessage";
	};
	try {
		createDeliver(rt)(job);
		assert.equal(delivered.length, 1);
	} finally {
		rt.closeDb();
	}
});

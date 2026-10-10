import test from "node:test";
import assert from "node:assert/strict";

import { exitCodeFromSignal } from "../src/pi/launch.js";
import { shouldResumeRecentSession } from "../src/cli.js";

test("exitCodeFromSignal maps POSIX signals to conventional shell exit codes", () => {
	assert.equal(exitCodeFromSignal("SIGTERM"), 143);
	assert.equal(exitCodeFromSignal("SIGSEGV"), 139);
});

test("bare launches always start fresh; resume only via explicit flags", () => {
	const bare = { hasPiArgs: false, newSession: false, hasPrompt: false, env: {} };
	assert.equal(shouldResumeRecentSession(bare), false);
	assert.equal(shouldResumeRecentSession({ ...bare, hasPiArgs: true }), false);
	assert.equal(shouldResumeRecentSession({ ...bare, mode: "rpc" }), false);
});

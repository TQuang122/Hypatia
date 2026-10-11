import assert from "node:assert/strict";
import test from "node:test";

import { describeOAuthLoginFailure } from "../src/model/commands.js";

test("invalid_grant login failures explain how to recover", () => {
	const error = new Error("invalid_grant: authorization code rejected");
	const explained = describeOAuthLoginFailure("anthropic", error);
	assert.ok(explained instanceof Error);
	assert.match(explained.message, /stale browser session/i);
	assert.match(explained.message, /sign out.*private window/i);
	assert.match(explained.message, /hypatia model login anthropic/);
});

test("OpenAI invalid_grant guidance includes the Codex login option", () => {
	const explained = describeOAuthLoginFailure("openai", new Error("invalid_grant"));
	assert.ok(explained instanceof Error);
	assert.match(explained.message, /hypatia model login openai-codex/);
});

test("other login failures remain unchanged", () => {
	const error = new Error("provider is busy");
	assert.equal(describeOAuthLoginFailure("anthropic", error), error);
	assert.equal(describeOAuthLoginFailure("anthropic", "invalid_grant"), "invalid_grant");
});

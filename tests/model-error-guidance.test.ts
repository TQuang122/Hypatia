import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelErrorRecoveryGuidance, registerModelErrorGuidance } from "../extensions/research-tools/model-error-guidance.js";

test("model errors get focused recovery guidance for common provider failures", () => {
	assert.match(modelErrorRecoveryGuidance("model_not_supported for this account") ?? "", /\/model/);
	assert.match(modelErrorRecoveryGuidance("insufficient_quota: no credits") ?? "", /credits|billing/i);
	assert.match(modelErrorRecoveryGuidance("429 rate_limit_exceeded") ?? "", /rate limit|quota/i);
	assert.match(modelErrorRecoveryGuidance("401 invalid_api_key") ?? "", /hypatia model login <provider>/);
	assert.match(modelErrorRecoveryGuidance("503 service temporarily unavailable") ?? "", /retry|temporarily/i);
	assert.match(modelErrorRecoveryGuidance("maximum context length exceeded") ?? "", /shorten|context window/i);
	assert.equal(modelErrorRecoveryGuidance("Unexpected response shape"), undefined);
});

test("message-end guidance only augments failed assistant messages", async () => {
	const handlers = new Map<string, (event: unknown) => unknown>();
	const api = {
		on(event: string, handler: (event: never) => unknown) {
			handlers.set(event, handler as (event: unknown) => unknown);
			return () => undefined;
		},
	} as unknown as ExtensionAPI;
	registerModelErrorGuidance(api);
	const handler = handlers.get("message_end");
	assert.ok(handler);

	const message = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "401 invalid_api_key",
	};
	const result = await handler({ type: "message_end", message }) as { message?: { errorMessage?: string; role: string } } | undefined;
	assert.equal(result?.message?.role, "assistant");
	assert.match(result?.message?.errorMessage ?? "", /401 invalid_api_key/);
	assert.match(result?.message?.errorMessage ?? "", /Hypatia recovery:.*hypatia model login <provider>/);

	const completed = await handler({ type: "message_end", message: { role: "assistant", stopReason: "stop", errorMessage: "" } });
	assert.equal(completed, undefined);
	const toolError = await handler({ type: "message_end", message: { role: "user", stopReason: "error", errorMessage: "401 invalid_api_key" } });
	assert.equal(toolError, undefined);
});

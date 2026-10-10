import assert from "node:assert/strict";
import test from "node:test";

import { thinkingColor } from "../extensions/research-tools/chat-presentation.js";

test("composer thinking colors follow the theme token for each level", () => {
	assert.deepEqual(
		(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => thinkingColor(level)),
		["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"],
	);
	assert.equal(thinkingColor(undefined), "borderMuted");
});

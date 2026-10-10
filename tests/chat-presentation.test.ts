import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { thinkingColor } from "../extensions/research-tools/chat-presentation.js";

test("composer thinking colors follow the theme token for each level", () => {
	assert.deepEqual(
		(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => thinkingColor(level)),
		["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"],
	);
	assert.equal(thinkingColor(undefined), "borderMuted");
});

test("Hypatia thinking colors match Pi dark's resolved palette", () => {
	const theme = JSON.parse(readFileSync(new URL("../.hypatia/themes/hypatia.json", import.meta.url), "utf8")) as {
		vars: Record<string, string>;
		colors: Record<string, string>;
	};
	const levels = ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"];
	const colors = levels.map((level) => theme.vars[theme.colors[level]!] ?? theme.colors[level]);
	assert.deepEqual(colors, ["#6c767b", "#68808d", "#5489a4", "#6185cc", "#9776e5", "#de54c1", "#fe5462"]);
});

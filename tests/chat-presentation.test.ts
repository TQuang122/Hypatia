import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Markdown, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

import { thinkingColor } from "../extensions/research-tools/chat-presentation.js";

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => `<italic>${text}</italic>`,
	strikethrough: (text) => text,
	underline: (text) => text,
};

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

test("Pi renders display math upright with its native Unicode LaTeX layout", () => {
	const source = [
		"Inline $x_i$ remains in prose.",
		"",
		"$$",
		String.raw`E[Y \mid do(X=x)] = \sum_z E[Y \mid X=x,Z=z]P(Z=z)`,
		"$$",
		"",
		String.raw`\[`,
		String.raw`\frac{1}{N}\sum_{i=1}^{N} x_i^2`,
		String.raw`\]`,
	].join("\n");
	const rendered = new Markdown(source, 0, 0, plainMarkdownTheme).render(48);
	const output = rendered.join("\n");
	assert.ok(output.includes("∑"));
	assert.ok(output.includes("─"));
	assert.ok(!output.includes("<italic>"));
	assert.ok(rendered.every((line) => visibleWidth(line) <= 48));
});

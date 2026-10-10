import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { installHypatiaHeader } from "../extensions/research-tools/header.js";

type HeaderFactory = (_tui: unknown, theme: {
	fg: (_color: string, text: string) => string;
	bold: (text: string) => string;
}) => {
	render: (width: number) => string[];
	invalidate: () => void;
};

test("Hypatia header keeps its mark, project, and session without repeating footer metrics", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "hypatia-header-project-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	let headerFactory: HeaderFactory | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "openai", id: "gpt-5.5" },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 2_500, contextWindow: 10_000, percent: 25 }),
		cwd,
		sessionManager: {
			getBranch: () => [],
			getSessionName: () => "session-name",
			getSessionId: () => "session-1",
		},
		ui: {
			setHeader: (factory: HeaderFactory) => {
				headerFactory = factory;
			},
		},
	};

	await installHypatiaHeader(ctx as any);
	assert.ok(headerFactory);

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	for (const width of [121, 80, 50]) {
		const lines = headerFactory(undefined, theme).render(width);
		assert.equal(lines.length, 3);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`expected line width ${visibleWidth(line)} to fit ${width}: ${line}`,
			);
		}
		const header = lines.join("\n");
		assert.ok(header.includes("Hypatia"));
		assert.equal(header.includes("openai/gpt-5.5"), false);
		assert.equal(header.includes("high"), false);
		assert.equal(header.includes("25%"), false);
		assert.ok(header.includes("session-name"));
		assert.ok(header.includes("hypatia-header-project-"));
	}
	for (const width of [1, 2, 5, 20]) {
		for (const line of headerFactory(undefined, theme).render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("Hypatia header only uses universal theme colors", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "hypatia-header-theme-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	let headerFactory: HeaderFactory | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "openai", id: "gpt-5.5" },
		getContextUsage: () => ({ percent: 10 }),
		cwd,
		sessionManager: { getBranch: () => [], getSessionName: () => "s", getSessionId: () => "s" },
		ui: { setHeader: (factory: HeaderFactory) => { headerFactory = factory; } },
	};
	await installHypatiaHeader(ctx as any);
	assert.ok(headerFactory);
	// Pi throws on unknown theme colors; only accent/text/dim are guaranteed.
	const strictTheme = {
		fg: (color: string, text: string) => {
			assert.ok(["accent", "text", "dim"].includes(color), `unexpected theme color: ${color}`);
			return text;
		},
		bold: (text: string) => text,
	};
	for (const width of [121, 80, 50]) {
		headerFactory(undefined, strictTheme).render(width);
	}
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";

import { installHypatiaHeader, registerPinnedPrompt } from "../extensions/research-tools/header.js";

type HeaderFactory = (_tui: unknown, theme: {
	fg: (_color: string, text: string) => string;
	bg: (_color: string, text: string) => string;
	bold: (text: string) => string;
}) => {
	render: (width: number) => string[];
	invalidate: () => void;
};

test("Hypatia defaults the fullscreen jump-to-latest shortcut to Escape", () => {
	const keybindings = JSON.parse(readFileSync(new URL("../.hypatia/config/keybindings.json", import.meta.url), "utf8")) as Record<string, unknown>;
	assert.equal(keybindings["tui.altScreen.bottom"], "esc");
});

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
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	for (const width of [121, 80, 50]) {
		const lines = headerFactory(undefined, theme).render(width);
		assert.equal(lines.length, 4);
		assert.equal(lines[3], "");
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

test("Hypatia H mark owns the accent while duplicate workspace names and UUIDs are compacted", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-header-identity-"));
	const cwd = join(root, "workspaces", "Hypatia");
	mkdirSync(cwd, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let headerFactory: HeaderFactory | undefined;
	const sessionId = "01a13481-1ba2-764c-b786-85986731e071";
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		sessionManager: { getSessionName: () => undefined, getSessionId: () => sessionId },
		ui: { setHeader: (factory: HeaderFactory) => { headerFactory = factory; } },
	};
	await installHypatiaHeader(ctx as any);
	assert.ok(headerFactory);
	const colors: Array<{ color: string; text: string }> = [];
	const theme = {
		fg: (color: string, text: string) => { colors.push({ color, text }); return text; },
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const lines = headerFactory(undefined, theme).render(100);
	assert.match(lines[0]!, /Hypatia 0\.1\.1/);
	assert.match(lines[1]!, /workspaces\/Hypatia/);
	assert.match(lines[2]!, /session 01a13481/);
	assert.equal(lines.join("\n").includes(sessionId), false);
	assert.deepEqual(colors.filter(({ color }) => color === "accent").map(({ text }) => text), ["███ ███", "███████", "███ ███"]);
	assert.ok(colors.some(({ color, text }) => color === "text" && text === "Hypatia"));
	assert.ok(colors.some(({ color, text }) => color === "dim" && text === " 0.1.1"));
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
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	for (const width of [121, 80, 50]) {
		headerFactory(undefined, strictTheme).render(width);
	}
});

test("fullscreen header uses two compact content lines on short terminals", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "hypatia-header-short-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	let headerFactory: HeaderFactory | undefined;
	const ctx = {
		hasUI: true, mode: "tui", cwd,
		sessionManager: { getBranch: () => [], getSessionName: () => "short-session", getSessionId: () => "s" },
		ui: { setHeader: (factory: HeaderFactory) => { headerFactory = factory; } },
	};
	await installHypatiaHeader(ctx as any);
	assert.ok(headerFactory);
	const tui = { mode: "fullscreen", terminal: { rows: 22 } };
	const lines = headerFactory(tui, { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text }).render(80);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /Hypatia/);
	assert.match(lines[0]!, /hypatia-header-short-/);
	assert.match(lines[1]!, /short-session/);
});

test("latest prompt remains pinned after the agent settles and the next prompt replaces it", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "hypatia-pinned-prompt-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, (...args: any[]) => void>();
	type PromptWidget = (tui: unknown, theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string }) => { render: (width: number) => string[] };
	let widgetFactory: PromptWidget | undefined;
	const readWidget = (): PromptWidget | undefined => widgetFactory;
	let headerFactory: HeaderFactory | undefined;
	let layoutRoot: any;
	let staleContext = false;
	const ui = {
		theme: undefined,
		setWidget: (_key: string, content: unknown) => {
			widgetFactory = typeof content === "function" ? content as PromptWidget : undefined;
		},
		setHeader: (factory: HeaderFactory) => { headerFactory = factory; },
	};
	const ctx = {
		mode: "tui", hasUI: true, cwd,
		sessionManager: { getBranch: () => [], getSessionName: () => "pinned", getSessionId: () => "s" },
		get ui() {
			if (staleContext) throw new Error("stale extension context");
			return ui;
		},
	};
	const pi = { on: (event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); return () => {}; } };
	const prompt = registerPinnedPrompt(pi as any);
	const emit = (event: string, ...args: any[]) => handlers.get(event)?.(...args);
	emit("session_start", {}, ctx);
	await installHypatiaHeader(ctx as any, undefined, prompt, "hidden");
	assert.ok(headerFactory);
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
	const tui = {
		mode: "fullscreen", terminal: { rows: 24 },
		children: Array.from({ length: 7 }, () => new Text("region", 0, 0)),
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
		setLayoutRoot: (root: unknown) => { layoutRoot = root; },
	};
	const header = headerFactory(tui, theme);
	assert.ok(layoutRoot);
	assert.equal(prompt.stickyTop, true);

	emit("input", { source: "rpc", text: "Do not pin RPC input" });
	emit("before_agent_start");
	assert.equal(readWidget(), undefined);

	emit("input", { source: "interactive", text: "Compare the evidence" });
	assert.equal(readWidget(), undefined);
	emit("before_agent_start");
	const widget = readWidget();
	assert.ok(widget);
	staleContext = true;
	header.render(40);
	const promptRow = layoutRoot.children[0].render(40) as string[];
	assert.ok(promptRow[0]?.includes("You › Compare the evidence"));
	assert.equal(promptRow.length, 1, "short fullscreen terminals omit the separator row");
	const rendered = widget(tui, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text });
	assert.deepEqual(rendered.render(40), []);
	staleContext = false;
	const dockFallback = widget({ mode: "regular" }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text });
	for (const width of [1, 2, 5, 20, 40]) {
		assert.ok(dockFallback.render(width).every((line) => visibleWidth(line) <= width));
	}
	assert.ok(dockFallback.render(40)[0]?.includes("You › Compare the evidence"));

	emit("agent_settled");
	assert.ok(readWidget());
	assert.ok((layoutRoot.children[0].render(40) as string[])[0]?.includes("You › Compare the evidence"));
	emit("input", { source: "interactive", text: "A new research question" });
	emit("before_agent_start");
	assert.ok((layoutRoot.children[0].render(40) as string[])[0]?.includes("You › A new research question"));
	emit("session_start", {}, ctx);
	assert.equal(readWidget(), undefined);
});

test("pinned prompt follows the transcript row and hides while that prompt is visible", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "hypatia-prompt-scroll-sync-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	let headerFactory: HeaderFactory | undefined;
	let layoutRoot: any;
	const ctx = {
		mode: "tui", hasUI: true, cwd,
		sessionManager: { getBranch: () => [], getSessionName: () => "scroll-sync", getSessionId: () => "s" },
		ui: {
			setHeader: (factory: HeaderFactory) => { headerFactory = factory; },
		},
	};
	const backgroundTokens: string[] = [];
	const foregroundTokens: string[] = [];
	const theme = {
		fg: (color: string, text: string) => { foregroundTokens.push(color); return text; },
		bg: (color: string, text: string) => { backgroundTokens.push(color); return text; },
		bold: (text: string) => text,
	};
	await installHypatiaHeader(ctx as any, undefined, { text: "Latest prompt", stickyTop: false }, "hidden");
	assert.ok(headerFactory);

	class UserMessageComponent extends Container {
		constructor(readonly text: string, rows = 1) {
			super();
			this.addChild(new Text(Array(rows).fill(text).join("\n"), 0, 0));
		}
	}
	const document = new Container();
	const headerContent = new Container();
	headerContent.addChild(new Text("header", 0, 0));
	const loadedResources = new Container();
	loadedResources.addChild(new Text("resources", 0, 0));
	const chat = new Container();
	chat.addChild(new UserMessageComponent("Older prompt", 2));
	chat.addChild(new Text("answer\nanswer\nanswer\nanswer", 0, 0));
	chat.addChild(new UserMessageComponent("Latest prompt"));
	chat.addChild(new Text("latest answer\nlatest answer\nlatest answer\nlatest answer\nlatest answer", 0, 0));
	document.addChild(headerContent);
	document.addChild(loadedResources);
	document.addChild(chat);
	const tui = {
		mode: "fullscreen", terminal: { rows: 40 },
		children: [document, ...Array.from({ length: 6 }, () => new Text("region", 0, 0))],
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
		setLayoutRoot: (root: unknown) => { layoutRoot = root; },
	};
	headerFactory(tui, theme);
	const promptRow = layoutRoot.children[0];
	const transcript = layoutRoot.children[1];
	const totalRows = document.render(40).length;
	transcript.updateLayout(totalRows, 4, () => {});
	const rowText = () => (promptRow.render(40) as string[]).join("");

	transcript.scrollTo(5);
	const olderPromptRow = promptRow.render(40) as string[];
	assert.match(olderPromptRow[0]!, /You › Older prompt/);
	assert.equal(olderPromptRow.length, 2);
	assert.ok(olderPromptRow.every((line: string) => visibleWidth(line) === 40));
	assert.match(olderPromptRow[1]!, /─/);
	assert.ok(backgroundTokens.includes("userMessageBg"));
	assert.ok(foregroundTokens.includes("borderMuted"));
	transcript.scrollTo(2);
	assert.equal(rowText(), "");
	transcript.scrollTo(3);
	assert.equal(rowText(), "");
	transcript.scrollTo(4);
	assert.match(rowText(), /You › Older prompt/);
	transcript.scrollTo(9);
	assert.match(rowText(), /You › Latest prompt/);
});

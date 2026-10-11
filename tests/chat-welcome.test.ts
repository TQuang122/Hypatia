import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { registerChatWelcome } from "../extensions/research-tools/chat-welcome.js";

test("empty-session logo transitions to research commands on interaction and hides after send", async () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	let editor = "", terminalInput: ((data: string) => undefined) | undefined;
	let widgetFactory: ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
	const tipVisibility: boolean[] = [];
	const pi = { on: (event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); } } as any;
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/tmp/hypatia-welcome-test",
		sessionManager: { getEntries: () => [] }, isIdle: () => true, hasPendingMessages: () => false,
		ui: {
			getEditorText: () => editor,
			setWidget: (_id: string, factory: typeof widgetFactory) => { widgetFactory = factory; },
			onTerminalInput: (handler: (data: string) => undefined) => { terminalInput = handler; return () => {}; },
		},
	};
	registerChatWelcome(pi, { setWelcomeVisible: (value: boolean) => tipVisibility.push(value) } as any);
	handlers.get("session_start")!({ reason: "new" }, ctx);
	assert.ok(widgetFactory, "new session displays the logo widget");

	editor = "What is scaling?";
	terminalInput!("W");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(widgetFactory);
	const panel = widgetFactory({ mode: "fullscreen", terminal: { rows: 30 } }, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
	const content = panel.render(100).join("\n");
	assert.match(content, /\/lit <topic>/u);
	assert.match(content, /\/deepresearch <topic>/u);
	assert.match(content, /\/idea <goal>/u);
	assert.match(content, /\/autoresearch <idea>/u);
	assert.match(content, /\/help/u);
	assert.ok(panel.render(100).every((line) => visibleWidth(line) <= 100));

	handlers.get("input")!({ source: "interactive", text: editor }, ctx);
	assert.equal(widgetFactory, undefined, "sending the prompt hides the command panel");
	assert.deepEqual(tipVisibility, [true, true, false]);
});

test("shortcut dismissal shows a compact command list on short fullscreen terminals", async () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	let terminalInput: ((data: string) => undefined) | undefined;
	let widgetFactory: ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/tmp/hypatia-welcome-test",
		sessionManager: { getEntries: () => [] }, isIdle: () => true, hasPendingMessages: () => false,
		ui: {
			getEditorText: () => "",
			setWidget: (_id: string, factory: typeof widgetFactory) => { widgetFactory = factory; },
			onTerminalInput: (handler: (data: string) => undefined) => { terminalInput = handler; return () => {}; },
		},
	};
	registerChatWelcome({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) } as any, { setWelcomeVisible() {} } as any);
	handlers.get("session_start")!({ reason: "startup" }, ctx);
	terminalInput!("\u001b[B");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(widgetFactory);
	const content = widgetFactory({ mode: "fullscreen", terminal: { rows: 18 } }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(60).join("\n");
	assert.match(content, /\/lit/u);
	assert.match(content, /\/deepresearch/u);
	assert.match(content, /\/autoresearch/u);
	assert.match(content, /\/help/u);
	assert.doesNotMatch(content, /\/recipe/u);
});

test("submitting a slash command hides the panel even when Pi does not emit a user input event", async () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	let editor = "", terminalInput: ((data: string) => undefined) | undefined;
	let widgetFactory: ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/tmp/hypatia-welcome-test",
		sessionManager: { getEntries: () => [] }, isIdle: () => true, hasPendingMessages: () => false,
		ui: {
			getEditorText: () => editor,
			setWidget: (_id: string, factory: typeof widgetFactory) => { widgetFactory = factory; },
			onTerminalInput: (handler: (data: string) => undefined) => { terminalInput = handler; return () => {}; },
		},
	};
	registerChatWelcome({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) } as any, { setWelcomeVisible() {} } as any);
	handlers.get("session_start")!({ reason: "startup" }, ctx);
	editor = "/help";
	terminalInput!("/");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(widgetFactory, "panel remains visible while the slash command is being drafted");
	terminalInput!("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(widgetFactory, undefined, "submitting a slash command clears the panel");
});

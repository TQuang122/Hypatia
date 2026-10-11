import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { registerDiscoveryCommands } from "../extensions/research-tools/discovery.js";
import { buildHelpSections, registerHelpCommand } from "../extensions/research-tools/help.js";

test("Hypatia help omits generic scheduler and process package commands", async () => {
	const registered = new Map<string, { handler: (_args: string[], ctx: unknown) => Promise<void> }>();
	const liveCommandNames = [
		"agents",
		"run",
		"chain",
		"parallel",
		"lit",
		"deepresearch",
		"ps",
		"schedule-prompt",
		"search",
		"websearch",
		"hotkeys",
		"new",
		"quit",
		"exit",
	];
	const pi = {
		getCommands: () => [
			...liveCommandNames.map((name) => ({ name, description: `${name} command` })),
			...Array.from(registered, ([name, command]) => ({ name, description: `${name} command`, ...command })),
		],
		registerCommand: (name: string, command: { handler: (_args: string[], ctx: unknown) => Promise<void> }) => {
			registered.set(name, command);
		},
	};
	let panel: { render(width: number): string[]; handleInput(data: string): void; focused: boolean } | undefined;
	let editorText = "";
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => typeof panel) => {
				panel = factory({ terminal: { rows: 24 }, requestRender() {} }, {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
					style: (text: string) => text,
					colors: { customMessageBg: "", selectedBg: "" },
				}, undefined, () => {});
			},
			setEditorText: (value: string) => { editorText = value; },
			notify: () => undefined,
		},
	};

	registerHelpCommand(pi as any);
	await registered.get("help")?.handler([], ctx);

	assert.ok(panel);
	const commands = buildHelpSections(pi as any).flatMap((section) => section.commands.map((command) => command.usage));
	assert.ok(commands.some((item) => item.startsWith("/search")));
	assert.ok(commands.some((item) => item.startsWith("/lit ")));
	assert.ok(commands.some((item) => item.startsWith("/deepresearch ")));
	assert.ok(commands.some((item) => item.startsWith("/websearch")));
	assert.ok(commands.some((item) => item.startsWith("/hotkeys")));
	assert.equal(commands.some((item) => item.startsWith("/ps ")), false);
	assert.equal(commands.some((item) => item.startsWith("/schedule-prompt ")), false);
	panel.focused = true;
	panel.handleInput("/");
	for (const key of "deepresearch") panel.handleInput(key);
	panel.handleInput("\r");
	panel.handleInput("\r");
	assert.equal(editorText, "/deepresearch ");
	assert.ok(panel.render(100).every((line) => visibleWidth(line) <= 100));
});

test("Hypatia tool browser omits generic scheduler and process package tools", async () => {
	type RegisteredCommand = {
		description?: string;
		handler: (_args: string[], ctx: unknown) => Promise<void>;
	};
	const repoRoot = "/tmp/hypatia";
	const localSourceInfo = {
		source: "cli",
		path: `${repoRoot}/extensions/research-tools.ts`,
		scope: "temporary",
		origin: "top-level",
	};
	const windowsLocalSourceInfo = {
		...localSourceInfo,
		path: "C:\\hypatia\\extensions\\research-tools.ts",
	};
	const packageSourceInfo = (source: string) => ({
		source,
		path: `${repoRoot}/node_modules/${source.replace(/^npm:/, "")}/dist/index.js`,
		scope: "project",
		origin: "package",
	});
	const registered = new Map<string, RegisteredCommand>();
	const pi = {
		getCommands: () => [],
		getAllTools: () => [
			{
				name: "alpha_search",
				description: "search papers",
				parameters: { properties: { query: {} } },
				sourceInfo: localSourceInfo,
			},
			{
				name: "hf_dataset_info",
				description: "inspect datasets",
				parameters: { properties: { dataset: {} } },
				sourceInfo: windowsLocalSourceInfo,
			},
			{
				name: "web_search",
				description: "web search",
				parameters: { properties: { query: {} } },
				sourceInfo: packageSourceInfo("npm:pi-web-access"),
			},
			{
				name: "document_parse",
				description: "parse documents",
				parameters: { properties: { path: {} } },
				sourceInfo: packageSourceInfo("npm:pi-docparser"),
			},
			{
				name: "subagent",
				description: "delegate research tasks",
				parameters: { properties: { agent: {}, task: {} } },
				sourceInfo: packageSourceInfo("npm:pi-subagents"),
			},
			{
				name: "schedule_prompt",
				description: "schedule a prompt",
				parameters: { properties: { prompt: {} } },
				sourceInfo: packageSourceInfo("npm:pi-schedule-prompt"),
			},
			{
				name: "process_list",
				description: "list background processes",
				parameters: { properties: {} },
				sourceInfo: packageSourceInfo("npm:pi-processes"),
			},
		],
		registerCommand: (name: string, command: RegisteredCommand) => {
			registered.set(name, command);
		},
	};
	const selectedItems: string[][] = [];
	const ctx = {
		ui: {
			select: async (_title: string, items: string[]) => {
				selectedItems.push(items);
				return undefined;
			},
			setEditorText: () => undefined,
			notify: () => undefined,
		},
	};

	registerDiscoveryCommands(pi as any);
	await registered.get("tools")?.handler([], ctx);

	const toolItems = selectedItems[0] ?? [];
	assert.ok(toolItems.some((item) => item.startsWith("alpha_search ") && item.endsWith("[extension]")));
	assert.ok(toolItems.some((item) => item.startsWith("hf_dataset_info ") && item.endsWith("[extension]")));
	assert.ok(toolItems.some((item) => item.startsWith("web_search ")));
	assert.ok(toolItems.some((item) => item.startsWith("document_parse ")));
	assert.ok(toolItems.some((item) => item.startsWith("subagent ")));
	assert.equal(toolItems.some((item) => item.startsWith("schedule_prompt ")), false);
	assert.equal(toolItems.some((item) => item.startsWith("process_list ")), false);
});

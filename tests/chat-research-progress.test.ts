import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChatTurnOutput } from "../extensions/research-tools/chat-turn-output.js";

type Handler = (event: any, context?: any) => void;

function setup() {
	const listeners = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(event: unknown) => void>>();
	const widgets: Array<{ key: string; content: unknown }> = [];
	const pi = {
		on(name: string, handler: Handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (event: unknown) => void) {
				const handlers = bus.get(name) ?? new Set(); handlers.add(handler); bus.set(name, handlers);
				return () => handlers.delete(handler);
			},
			emit(name: string, event: unknown) { for (const handler of bus.get(name) ?? []) handler(event); },
		},
		registerEntryRenderer() {}, appendEntry() {},
	} as unknown as ExtensionAPI;
	const context = {
		mode: "tui", hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
		},
	};
	const emit = (name: string, event: any = {}) => { for (const handler of listeners.get(name) ?? []) handler({ type: name, ...event }, context); };
	return { pi, context, widgets, emit };
}

function renderProgress(widgets: Array<{ key: string; content: unknown }>): string {
	const widget = [...widgets].reverse().find((item) => item.key === "hypatia-turn-progress");
	assert.equal(typeof widget?.content, "function");
	const factory = widget!.content as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text });
	return component.render(100).join("\n");
}

test("research progress follows observed search, reading, synthesis and verifier events", () => {
	const { pi, context, widgets, emit } = setup();
	const output = registerChatTurnOutput(pi);
	emit("session_start");
	emit("input", { text: "/deepresearch scaling laws", source: "interactive" });
	emit("agent_start");
	assert.match(renderProgress(widgets), /0 parent-visible sources/u);
	assert.match(renderProgress(widgets), /· Search.*· Read.*· Synthesize.*· Verify/u);
	pi.events.emit("hypatia:research-agent-activity", [{ id: "child-1", agent: "evidence-scout", currentTool: "web_search" }]);
	assert.match(renderProgress(widgets), /◌ Search/u, "search by a delegated agent updates the research stages");
	pi.events.emit("hypatia:research-agent-activity", [{ id: "child-1", agent: "evidence-scout", currentTool: "alpha_get_paper" }]);
	assert.match(renderProgress(widgets), /✓ Search.*◌ Read/u);
	pi.events.emit("hypatia:research-agent-activity", []);
	assert.match(renderProgress(widgets), /✓ Search.*✓ Read/u);
	emit("message_update", { assistantMessageEvent: { type: "text_start" } });
	assert.match(renderProgress(widgets), /◌ Synthesize/u);

	emit("tool_execution_start", { toolCallId: "search-1", toolName: "alpha_search", args: { query: "scaling laws" } });
	assert.match(renderProgress(widgets), /◌ Search/u);
	emit("tool_execution_end", {
		toolCallId: "search-1", toolName: "alpha_search", isError: false,
		result: { details: { results: [{ doi: "10.1234/paper-1", title: "Paper one" }, { doi: "10.1234/paper-2", title: "Paper two" }] } },
	});
	assert.match(renderProgress(widgets), /2 parent-visible sources/u);
	assert.match(renderProgress(widgets), /✓ Search/u);
	emit("tool_execution_start", { toolCallId: "search-2", toolName: "hypatia_science_database_search", args: { query: "scaling laws", source: "openalex" } });
	emit("tool_execution_end", {
		toolCallId: "search-2", toolName: "hypatia_science_database_search", isError: false,
		result: { details: { results: [{ doi: "10.1234/PAPER-1", title: "Duplicate" }, { doi: "10.1234/paper-3", title: "Paper three" }] } },
	});
	assert.match(renderProgress(widgets), /3 parent-visible sources/u, "duplicate identifiers are counted once across searches");

	emit("tool_execution_start", { toolCallId: "read-1", toolName: "alpha_get_paper", args: { paper: "paper-1" } });
	assert.match(renderProgress(widgets), /◌ Read/u);
	emit("tool_execution_end", { toolCallId: "read-1", toolName: "alpha_get_paper", isError: false, result: { details: {} } });
	emit("message_update", { assistantMessageEvent: { type: "text_start" } });
	assert.match(renderProgress(widgets), /◌ Synthesize/u);

	emit("tool_execution_start", { toolCallId: "audit-1", toolName: "subagent", args: { agent: "auditor", async: true } });
	emit("tool_execution_end", { toolCallId: "audit-1", toolName: "subagent", isError: false, result: { details: {} } });
	pi.events.emit("subagent:async-started", { id: "audit-run", agent: "auditor" });
	assert.match(renderProgress(widgets), /◌ Verify/u);
	pi.events.emit("subagent:async-complete", { id: "audit-run", agent: "auditor", state: "complete" });
	assert.match(renderProgress(widgets), /✓ Verify/u);

	emit("agent_end", { messages: [] });
	emit("agent_settled");
	output.setActivity(false, false);
	assert.equal(widgets.at(-1)?.content, undefined);
	void context;
});

test("research-only progress does not appear on ordinary chat turns", () => {
	const { pi, widgets, emit } = setup();
	registerChatTurnOutput(pi);
	emit("session_start");
	emit("input", { text: "ordinary chat" });
	emit("agent_start");
	emit("tool_execution_start", { toolCallId: "s1", toolName: "alpha_search", args: {} });
	emit("tool_execution_end", { toolCallId: "s1", toolName: "alpha_search", isError: false, result: { details: { results: [{ doi: "10.1234/ABC", title: "A" }] } } });
	const widget = [...widgets].reverse().find((item) => item.key === "hypatia-turn-progress")!;
	assert.equal(widget.content instanceof Function, true);
	const component = (widget.content as (tui: unknown, theme: unknown) => { render(width: number): string[] })({ requestRender() {} }, { fg: (_color: string, text: string) => text });
	assert.doesNotMatch(component.render(100).join("\n"), /parent-visible sources/u);
});

test("a stopped async verifier leaves verification pending without claiming success", () => {
	const { pi, emit, widgets } = setup();
	registerChatTurnOutput(pi);
	emit("session_start");
	emit("input", { text: "/lit scaling laws" });
	emit("agent_start");
	const child = { runId: "workflow-1", childId: "audit", childRunId: "audit-run", agent: "auditor" };
	pi.events.emit("subagent:child-status", { ...child, status: "started" });
	assert.match(renderProgress(widgets), /◌ Verify/u);
	pi.events.emit("subagent:child-status", { ...child, status: "stopped" });
	assert.match(renderProgress(widgets), /· Verify/u);
	assert.doesNotMatch(renderProgress(widgets), /✓ Verify/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "pi-subagents/delegation";
import { Key, visibleWidth } from "@earendil-works/pi-tui";

import { registerSubagentActivityStatus } from "../extensions/research-tools/subagent-activity.js";

type EventHandler = (data: unknown) => void;
type ExtensionHandler = (event: { type: string }, ctx: unknown) => void;
type ShortcutHandler = (ctx: any) => void | Promise<void>;

function fakePi() {
	const busHandlers = new Map<string, Set<EventHandler>>();
	const lifecycleHandlers = new Map<string, ExtensionHandler[]>();
	const shortcuts = new Map<string, ShortcutHandler>();
	const events = {
		on(channel: string, handler: EventHandler) {
			const handlers = busHandlers.get(channel) ?? new Set<EventHandler>();
			handlers.add(handler);
			busHandlers.set(channel, handlers);
			return () => handlers.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of busHandlers.get(channel) ?? []) handler(data);
		},
	};
	const pi = {
		events,
		registerShortcut: (key: string, options: { handler: ShortcutHandler }) => { shortcuts.set(key, options.handler); },
		on(event: string, handler: ExtensionHandler) {
			lifecycleHandlers.set(event, [...(lifecycleHandlers.get(event) ?? []), handler]);
			return () => undefined;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		shortcuts,
		emitBus(channel: string, data: unknown) {
			for (const handler of busHandlers.get(channel) ?? []) handler(data);
		},
		emitLifecycle(event: string, ctx: unknown, payload: Record<string, unknown> = {}) {
			for (const handler of lifecycleHandlers.get(event) ?? []) handler({ ...payload, type: event }, ctx);
		},
		async emitShortcut(key: string, ctx: unknown) {
			await shortcuts.get(key)?.(ctx);
		},
	};
}

test("active subagent status shows role, actual model, and progress without task text", () => {
	const { pi, emitBus, emitLifecycle } = fakePi();
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const context = {
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
		},
	};

	registerSubagentActivityStatus(pi);
	emitLifecycle("session_start", context);
	emitBus(SUBAGENT_DELEGATION_REQUEST_EVENT, {
		requestId: "request-1",
		ownerRunId: "parent-run",
		nodeId: "research-node",
		agent: "evidence-scout",
		task: "private research prompt that must not appear in status",
		model: "openai-codex/gpt-6-luna",
	});
	emitBus(SUBAGENT_DELEGATION_STARTED_EVENT, {
		requestId: "request-1",
		ownerRunId: "parent-run",
		nodeId: "research-node",
	});
	emitBus(SUBAGENT_DELEGATION_UPDATE_EVENT, {
		requestId: "request-1",
		ownerRunId: "parent-run",
		nodeId: "research-node",
		model: "openai-codex/gpt-6-luna",
		currentTool: "web_search",
		toolCount: 3,
		durationMs: 7_200,
	});

	const status = statusCalls.at(-1)?.text ?? "";
	assert.ok(statusCalls.at(-1)?.key);
	assert.ok(status.includes("evidence-scout"));
	assert.ok(status.includes("gpt-6-luna"));
	assert.ok(status.includes("web_search"));
	assert.ok(status.includes("3"));
	assert.equal(status.includes("private research prompt"), false);

	emitBus(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
		requestId: "request-1",
		ownerRunId: "parent-run",
		nodeId: "research-node",
		status: "completed",
		model: "openai-codex/gpt-6-luna",
	});
	assert.equal(statusCalls.at(-1)?.text, undefined);
});

test("async workflow children appear in the activity panel and clear when their run completes", () => {
	const { pi, emitLifecycle, emitBus } = fakePi();
	const { context, statuses, widgets } = activityContext();
	const agentActivity: unknown[] = [];
	pi.events.on("hypatia:research-agent-activity", (event) => agentActivity.push(event));
	pi.events.on("subagents:rpc:v1:request", (request) => {
		const requestId = (request as { requestId: string }).requestId;
		pi.events.emit(`subagents:rpc:v1:reply:${requestId}`, {
			version: 1, requestId, success: true,
			data: {
				fleet: { entries: [{ agent: "evidence-scout", model: "openai-codex/gpt-6-luna" }] },
				asyncSnapshot: { runs: [{ children: [{ id: "methods", kind: "step", activity: { currentTool: "web_search", toolCount: 4 } }] }] },
			},
		});
	});
	registerSubagentActivityStatus(pi);
	emitLifecycle("session_start", context);
	emitBus("subagent:child-status", {
		type: "subagent.child-status", version: 1, runId: "workflow-1", childId: "methods",
		status: "started", ts: Date.now(), source: "async", agent: "evidence-scout",
		label: "private prompt should not be rendered",
	});
	assert.match(statuses.at(-1) ?? "", /evidence-scout/u);
	const panelFactory = widgets.at(-1)?.content as ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
	assert.equal(typeof panelFactory, "function");
	const panel = panelFactory!({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		style: (text: string) => text,
		colors: { customMessageBg: "" },
	});
	assert.match(panel.render(100).join("\n"), /evidence-scout.*gpt-6-luna.*web_search.*4 tools/u);
	assert.equal(panel.render(100).join("\n").includes("private prompt"), false);
	assert.deepEqual(agentActivity.at(-1), [{ id: "workflow-1:methods", agent: "evidence-scout", currentTool: "web_search" }]);

	emitBus("subagent:async-complete", { id: "child-run-1", parentWorkflowRunId: "workflow-1", state: "complete" });
	assert.equal(typeof widgets.at(-1)?.content, "function", "a completed child must not hide its active siblings");
	emitBus("subagent:async-complete", { id: "workflow-1", state: "complete" });
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1)?.content, undefined);
	assert.deepEqual(agentActivity.at(-1), []);
});

test("standalone async subagents stay visible after the launch tool returns", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10_000 });
	const { pi, emitLifecycle, emitBus } = fakePi();
	const { context, statuses, widgets } = activityContext();
	const updates: unknown[] = [];
	pi.events.on("hypatia:research-agent-activity", (event) => updates.push(event));
	pi.events.on("subagents:rpc:v1:request", (request) => {
		const requestId = (request as { requestId: string }).requestId;
		pi.events.emit(`subagents:rpc:v1:reply:${requestId}`, {
			version: 1, requestId, success: true,
			data: {
				fleet: { entries: [{ agent: "evidence-scout", model: "openai-codex/gpt-6-luna", startedAt: 10_000 }] },
				asyncSnapshot: { runs: [{ id: "single-run", kind: "subagent", activity: { currentTool: "web_search", toolCount: 2 } }] },
			},
		});
	});
	registerSubagentActivityStatus(pi);
	t.after(() => emitLifecycle("session_shutdown", context));
	emitLifecycle("session_start", context);
	emitBus("subagent:async-started", {
		id: "single-run", mode: "single", agent: "evidence-scout", startedAt: 10_000, toolCallId: "tool-1",
		task: "private task text must not be published",
	});

	assert.ok(widgets.some((widget) => typeof widget.content === "function"));
	assert.match(statuses.at(-1) ?? "", /evidence-scout.*gpt-6-luna.*web_search.*2 tools/u);
	assert.deepEqual(updates.at(-1), [{ id: "async:single-run", agent: "evidence-scout", currentTool: "web_search" }]);

	emitBus("subagent:async-complete", { id: "single-run", runId: "single-run", agent: "evidence-scout", state: "complete" });
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1)?.content, undefined);
});

test("direct subagent snapshots replace stale tool and model fields", () => {
	const { pi, emitLifecycle } = fakePi();
	const statuses: Array<string | undefined> = [];
	const context = {
		mode: "tui",
		hasUI: true,
		ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
	};
	const args = {
		agent: "evidence-scout",
		model: "openai-codex/gpt-6-luna",
		task: "private task text",
	};

	registerSubagentActivityStatus(pi);
	emitLifecycle("session_start", context);
	emitLifecycle("tool_execution_start", context, {
		toolCallId: "tool-1",
		toolName: "subagent",
		args,
	});
	emitLifecycle("tool_execution_update", context, {
		toolCallId: "tool-1",
		toolName: "subagent",
		args,
		partialResult: {
			details: {
				progress: [{
					model: "openai-codex/gpt-6-luna",
					currentTool: "web_search",
					toolCount: 3,
					durationMs: 7_200,
				}],
			},
		},
	});
	assert.ok(statuses.at(-1)?.includes("web_search"));
	assert.ok(statuses.at(-1)?.includes("gpt-6-luna"));

	emitLifecycle("tool_execution_update", context, {
		toolCallId: "tool-1",
		toolName: "subagent",
		args,
		partialResult: { details: { progress: [{ toolCount: 4, durationMs: 9_100 }] } },
	});

	const nextSnapshot = statuses.at(-1) ?? "";
	assert.equal(nextSnapshot.includes("web_search"), false);
	assert.equal(nextSnapshot.includes("gpt-6-luna"), false);
	assert.equal(nextSnapshot.includes("private task text"), false);
	assert.ok(nextSnapshot.includes("4"));

	emitLifecycle("tool_execution_end", context, {
		toolCallId: "tool-1",
		toolName: "subagent",
	});
	assert.equal(statuses.at(-1), undefined);
});

test("subagent status stays hidden without a TUI and clears on session shutdown", () => {
	const { pi, emitBus, emitLifecycle } = fakePi();
	const statusCalls: Array<string | undefined> = [];
	registerSubagentActivityStatus(pi);
	const noUiContext = { mode: "print", hasUI: false, ui: { setStatus: (_key: string, text?: string) => statusCalls.push(text) } };

	emitLifecycle("session_start", noUiContext);
	emitBus(SUBAGENT_DELEGATION_REQUEST_EVENT, {
		requestId: "request-2",
		ownerRunId: "parent-run",
		nodeId: "node-2",
		agent: "critic",
		model: "anthropic/claude-opus-5-5",
	});
	emitBus(SUBAGENT_DELEGATION_STARTED_EVENT, {
		requestId: "request-2",
		ownerRunId: "parent-run",
		nodeId: "node-2",
	});
	assert.equal(statusCalls.length, 0);

	const liveContext = {
		mode: "tui",
		hasUI: true,
		ui: { setStatus: (_key: string, text: string | undefined) => statusCalls.push(text) },
	};
	emitLifecycle("session_start", liveContext);
	assert.equal(statusCalls.at(-1), undefined);
	emitBus(SUBAGENT_DELEGATION_REQUEST_EVENT, {
		requestId: "request-3",
		ownerRunId: "parent-run",
		nodeId: "node-3",
		agent: "auditor",
		model: "anthropic/claude-opus-5-5",
	});
	emitBus(SUBAGENT_DELEGATION_STARTED_EVENT, {
		requestId: "request-3",
		ownerRunId: "parent-run",
		nodeId: "node-3",
	});
	assert.ok(statusCalls.at(-1)?.includes("auditor"));
	const callsBeforeShutdown = statusCalls.length;
	emitLifecycle("session_shutdown", liveContext);
	assert.equal(statusCalls.at(-1), undefined);
	const callsAfterShutdown = statusCalls.length;
	emitBus(SUBAGENT_DELEGATION_UPDATE_EVENT, {
		requestId: "request-3",
		ownerRunId: "parent-run",
		nodeId: "node-3",
		toolCount: 10,
	});
	assert.equal(statusCalls.length, callsAfterShutdown);
	assert.ok(callsAfterShutdown > callsBeforeShutdown);
});

function activityContext() {
	const statuses: Array<string | undefined> = [];
	const hints: boolean[] = [];
	const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
	return {
		statuses, hints, widgets,
		context: {
			mode: "tui", hasUI: true,
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					statuses.push(text);
					hints.push(text === undefined);
				},
				setWidget: (key: string, content: unknown, options?: { placement?: string }) => widgets.push({ key, content, placement: options?.placement }),
			},
		},
	};
}

test("agent activity panel shows observed model, tool and elapsed time and can be collapsed", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10_000 });
	const { pi, emitLifecycle, emitBus, emitShortcut } = fakePi();
	const { context, widgets } = activityContext();
	const renders: number[] = [];
	registerSubagentActivityStatus(pi);
	t.after(() => emitLifecycle("session_shutdown", context));
	emitLifecycle("session_start", context);
	assert.equal(widgets.at(-1)?.content, undefined);

	emitBus(SUBAGENT_DELEGATION_REQUEST_EVENT, {
		requestId: "panel-agent", agent: "evidence-scout", model: "openai-codex/gpt-6-luna",
		task: "private paper search task must never appear",
	});
	const panelFactory = widgets.at(-1)?.content as ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
	assert.equal(widgets.at(-1)?.placement, "aboveEditor");
	assert.equal(typeof panelFactory, "function");
	const panel = panelFactory!({ mode: "fullscreen", terminal: { rows: 30, columns: 100 }, requestRender: () => renders.push(Date.now()) }, {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		style: (text: string) => text,
		colors: { customMessageBg: "" },
	});
	let lines = panel.render(100);
	assert.match(lines.join("\n"), /evidence-scout.*requested openai-codex\/gpt-6-luna.*starting.*0s/u);
	assert.equal(lines.some((line) => line.includes("private paper search task")), false);
	assert.ok(lines.every((line) => visibleWidth(line) <= 100));

	emitBus(SUBAGENT_DELEGATION_STARTED_EVENT, { requestId: "panel-agent" });
	emitBus(SUBAGENT_DELEGATION_UPDATE_EVENT, {
		requestId: "panel-agent", model: "openai-codex/gpt-6-luna", currentTool: "web_search", toolCount: 2, durationMs: 1_500,
	});
	lines = panel.render(100);
	assert.match(lines.join("\n"), /evidence-scout.*openai-codex\/gpt-6-luna.*web_search.*2 tools.*1s/u);
	t.mock.timers.tick(2_100);
	assert.ok(renders.length > 0, "elapsed time refreshes while an agent runs");
	assert.match(panel.render(100).join("\n"), /2s/u);

	await emitShortcut(Key.ctrlShift("a"), context);
	lines = panel.render(100);
	assert.equal(lines.length, 4, "collapsed panel keeps a compact bordered summary");
	assert.match(lines.join("\n"), /Ctrl\+Shift\+A expand/u);
	await emitShortcut(Key.ctrlShift("a"), context);
	lines = panel.render(100);
	assert.match(lines.join("\n"), /Ctrl\+Shift\+A collapse/u);
	assert.match(lines.join("\n"), /▸ evidence-scout/u);
	await emitShortcut(Key.ctrlShift("a"), context);
	assert.ok(panel.render(50)[0]!.includes("Ctrl+Shift+A expand"));
	assert.ok(panel.render(50).every((line) => visibleWidth(line) <= 50));

	emitBus(SUBAGENT_DELEGATION_RESPONSE_EVENT, { requestId: "panel-agent", status: "completed" });
	assert.equal(widgets.at(-1)?.content, undefined);
});

test("main activity follows observed streaming and stays busy until final settlement", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10_000 });
	const { pi, emitLifecycle } = fakePi();
	const { context, statuses, hints } = activityContext();
	registerSubagentActivityStatus(pi);
	t.after(() => emitLifecycle("session_shutdown", context));
	emitLifecycle("session_start", context);
	assert.equal(hints.at(-1), true);
	emitLifecycle("agent_start", context);
	assert.equal(hints.at(-1), false);
	assert.match(statuses.at(-1) ?? "", /Processing/);
	t.mock.timers.tick(2_100);
	assert.match(statuses.at(-1) ?? "", /2s/);
	emitLifecycle("message_update", context, { assistantMessageEvent: { type: "thinking_delta" } });
	assert.match(statuses.at(-1) ?? "", /Thinking/);
	emitLifecycle("message_update", context, { assistantMessageEvent: { type: "text_delta" } });
	assert.match(statuses.at(-1) ?? "", /Answering/);
	emitLifecycle("agent_end", context, { messages: [] });
	assert.match(statuses.at(-1) ?? "", /Finishing/);
	assert.equal(hints.at(-1), false);
	// Recovery/queued continuations can start after agent_end; elapsed time is retained.
	emitLifecycle("agent_start", context);
	assert.match(statuses.at(-1) ?? "", /2s/);
	emitLifecycle("agent_before_settle", context, { outcome: "completed" });
	emitLifecycle("agent_settled", context);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(hints.at(-1), true);
	const count = statuses.length;
	t.mock.timers.tick(5_000);
	assert.equal(statuses.length, count);
});

test("parallel tool completion leaves sibling activity visible and never exposes arguments", (t) => {
	const { pi, emitLifecycle } = fakePi();
	const { context, statuses, hints } = activityContext();
	registerSubagentActivityStatus(pi);
	t.after(() => emitLifecycle("session_shutdown", context));
	emitLifecycle("session_start", context);
	emitLifecycle("agent_start", context);
	emitLifecycle("tool_execution_start", context, { toolCallId: "search", toolName: "alpha_search", args: { query: "private query" } });
	emitLifecycle("tool_execution_start", context, { toolCallId: "read", toolName: "fetch_content", parentToolCallId: "search", args: { url: "private-url" } });
	assert.match(statuses.at(-1) ?? "", /Reading sources.*2 active tools/);
	emitLifecycle("tool_execution_end", context, { toolCallId: "read", toolName: "fetch_content", isError: false });
	assert.match(statuses.at(-1) ?? "", /Searching sources.*alpha_search/);
	assert.equal(hints.at(-1), false);
	assert.equal(statuses.join(" ").includes("private"), false);
	emitLifecycle("tool_execution_end", context, { toolCallId: "search", toolName: "alpha_search", isError: true });
	assert.match(statuses.at(-1) ?? "", /Tool failed.*alpha_search/);
	assert.equal(hints.at(-1), false);
	emitLifecycle("message_update", context, { assistantMessageEvent: { type: "text_delta" } });
	assert.match(statuses.at(-1) ?? "", /Answering/);
});

test("root failure and interruption use observed outcomes and reset for the next turn", (t) => {
	const { pi, emitLifecycle } = fakePi();
	const { context, statuses, hints } = activityContext();
	registerSubagentActivityStatus(pi);
	t.after(() => emitLifecycle("session_shutdown", context));
	emitLifecycle("session_start", context);
	for (const [outcome, label] of [["error", "Failed"], ["aborted", "Interrupted"]]) {
		emitLifecycle("agent_start", context);
		assert.match(statuses.at(-1) ?? "", /Processing/);
		emitLifecycle("agent_before_settle", context, { outcome });
		emitLifecycle("agent_settled", context);
		assert.match(statuses.at(-1) ?? "", new RegExp(label));
		assert.equal(hints.at(-1), false, "the footer prioritizes the failed/interrupted outcome");
	}
});

test("background subagents keep hints hidden after the main turn settles", (t) => {
	const { pi, emitLifecycle, emitBus } = fakePi();
	const { context, statuses, hints } = activityContext();
	registerSubagentActivityStatus(pi);
	t.after(() => emitLifecycle("session_shutdown", context));
	emitLifecycle("session_start", context);
	emitLifecycle("agent_start", context);
	emitBus(SUBAGENT_DELEGATION_REQUEST_EVENT, { requestId: "bg", agent: "auditor" });
	emitLifecycle("agent_before_settle", context, { outcome: "completed" });
	emitLifecycle("agent_settled", context);
	assert.match(statuses.at(-1) ?? "", /auditor/);
	assert.equal(hints.at(-1), false);
	emitBus(SUBAGENT_DELEGATION_RESPONSE_EVENT, { requestId: "bg", status: "completed" });
	assert.equal(statuses.at(-1), undefined);
	assert.equal(hints.at(-1), true);
});

test("blocking prompts and shutdown do not leave stale activity or timers", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const { pi, emitLifecycle } = fakePi();
	const { context, statuses, hints } = activityContext();
	registerSubagentActivityStatus(pi);
	emitLifecycle("session_start", context);
	emitLifecycle("ui_prompt_start", context, { title: "private prompt" });
	assert.equal(statuses.at(-1), "Waiting for input");
	assert.equal(hints.at(-1), false);
	emitLifecycle("ui_prompt_end", context);
	assert.equal(hints.at(-1), true);
	emitLifecycle("agent_start", context);
	emitLifecycle("session_shutdown", context);
	const count = statuses.length;
	t.mock.timers.tick(10_000);
	emitLifecycle("tool_execution_start", context, { toolCallId: "late", toolName: "write" });
	assert.equal(statuses.length, count);
	assert.equal(statuses.at(-1), undefined);
});

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "pi-subagents/delegation";
import { Key, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

const STATUS_KEY = "hypatia-activity";
const HINTS_WIDGET_KEY = "hypatia-chat-hints";
const MAX_VISIBLE_AGENTS = 2;
const ASYNC_STARTED_EVENT = "subagent:async-started";
const ASYNC_CHILD_STATUS_EVENT = "subagent:child-status";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

type ActiveSubagent = {
	readonly agent: string;
	readonly requestedModel?: string;
	readonly requestedAt: number;
	started: boolean;
	receivedProgress: boolean;
	model?: string;
	currentTool?: string;
	toolCount?: number;
	durationMs?: number;
	snapshotId?: string;
	asyncRunId?: string;
};

type StatusUI = Pick<ExtensionUIContext, "setStatus" | "theme"> & Partial<Pick<ExtensionUIContext, "setWidget">>;

class AgentActivityPanel implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: () => Theme,
		private readonly agents: () => ActiveSubagent[],
		private readonly isCollapsed: () => boolean,
	) {}

	invalidate(): void {}

	private agentLine(agent: ActiveSubagent): string {
		const model = agent.receivedProgress ? agent.model : agent.requestedModel;
		const current = agent.currentTool ?? (agent.started ? "running" : "starting");
		const elapsedMs = Math.max(agent.durationMs ?? 0, Date.now() - agent.requestedAt);
		return [
			agent.agent,
			model ? `${agent.receivedProgress ? "" : "requested "}${model}` : agent.receivedProgress ? "model unavailable" : undefined,
			current,
			agent.toolCount === undefined ? undefined : `${agent.toolCount} tools`,
			`${Math.max(0, Math.floor(elapsedMs / 1_000))}s`,
		]
			.filter((part): part is string => Boolean(part))
			.join(" · ");
	}

	private boxLine(text: string, width: number, color: "accent" | "muted" = "muted"): string {
		const theme = this.theme();
		const inner = Math.max(0, width - 4);
		const content = truncateToWidth(text, inner, "…");
		const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
		const bg = theme.colors.customMessageBg;
		return theme.style(`${theme.fg("borderMuted", "│")} ${theme.fg(color, content)}${padding} ${theme.fg("borderMuted", "│")}`, { bg });
	}

	render(width: number): string[] {
		const agents = this.agents();
		if (!agents.length || width <= 0) return [];
		const theme = this.theme();
		const collapsed = this.isCollapsed();
		const compactTerminal = width < 54 || this.tui.terminal.rows < 22;
		const visibleAgent = this.agentLine(agents[0]!);
		if (compactTerminal && collapsed) {
			const action = "Ctrl+Shift+A expand";
			const prefix = `◈ agents ${agents.length} · ${action}`;
			const line = `${prefix} · ${truncateToWidth(visibleAgent, Math.max(1, width - visibleWidth(prefix) - 3), "…")}`;
			return [truncateToWidth(theme.fg("accent", line), width, "…")];
		}

		const innerWidth = Math.max(1, width - 2);
		const showCollapsed = collapsed;
		const hint = `Ctrl+Shift+A ${showCollapsed ? "expand" : "collapse"}`;
		const title = `◈ Active agents · ${agents.length} · ${hint}`;
		const titleText = truncateToWidth(title, Math.max(0, width - 3), "…");
		const remaining = Math.max(0, width - 3 - visibleWidth(titleText));
		const top = theme.style(`${theme.fg("borderMuted", `╭─${"─".repeat(Math.max(0, innerWidth - 1))}╮`)}`, { bg: theme.colors.customMessageBg });
		const header = theme.style(
			`${theme.fg("borderMuted", "│")} ${theme.fg("accent", theme.bold(titleText))}${" ".repeat(remaining)}${theme.fg("borderMuted", "│")}`,
			{ bg: theme.colors.customMessageBg },
		);
		const bottom = theme.style(`${theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`)}`, { bg: theme.colors.customMessageBg });
		if (showCollapsed) return [top, header, this.boxLine(`${visibleAgent}${agents.length > 1 ? ` · +${agents.length - 1} more` : ""}`, width), bottom];

		const maxVisible = compactTerminal ? 1 : Math.max(1, Math.min(4, this.tui.terminal.rows - 20));
		const rows = agents.slice(0, maxVisible).map((agent) => this.boxLine(`▸ ${this.agentLine(agent)}`, width, "accent"));
		if (agents.length > rows.length) rows.push(this.boxLine(`+ ${agents.length - rows.length} more active`, width));
		return [top, header, ...rows, bottom];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function requestIdField(value: unknown): string | undefined {
	return isRecord(value) ? stringField(value, "requestId") : undefined;
}

function progressSnapshot(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || !isRecord(value.details)) return undefined;
	const details = value.details;
	const progress = details.progress;
	if (Array.isArray(progress) && isRecord(progress[0])) return progress[0];
	const results = details.results;
	if (!Array.isArray(results) || !isRecord(results[0])) return undefined;
	return isRecord(results[0].progress) ? results[0].progress : undefined;
}

function formatModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	return visibleWidth(model) > 28 ? truncateToWidth(model, 28, "…") : model;
}

function formatAgent(agent: ActiveSubagent): string {
	const model = agent.receivedProgress ? agent.model : agent.requestedModel;
	const details = [model ? `${agent.receivedProgress ? "" : "requested "}${formatModel(model)}` : undefined];
	if (agent.receivedProgress && !model) details.push("model unavailable");
	if (agent.currentTool) details.push(truncateToWidth(agent.currentTool, 22, "…"));
	else details.push(agent.started ? "running" : "starting");
	if (agent.toolCount !== undefined) details.push(`${agent.toolCount} tools`);
	if (agent.durationMs !== undefined) details.push(`${Math.max(0, Math.round(agent.durationMs / 1_000))}s`);
	return [agent.agent, ...details.filter((detail): detail is string => detail !== undefined)].join(" · ");
}

function formatStatus(agents: ReadonlyMap<string, ActiveSubagent>): string | undefined {
	if (agents.size === 0) return undefined;
	const visible = [...agents.values()].slice(0, MAX_VISIBLE_AGENTS).map(formatAgent);
	const more = agents.size > visible.length ? ` · +${agents.size - visible.length}` : "";
	return `agents ${agents.size} · ${visible.join(" | ")}${more}`;
}

function sessionUi(context: ExtensionContext): StatusUI | undefined {
	return context.mode === "tui" && context.hasUI ? context.ui : undefined;
}

function directSubagentCall(value: unknown): { key: string; agent: ActiveSubagent } | undefined {
	if (!isRecord(value) || value.toolName !== "subagent") return undefined;
	const args = value.args;
	if (!isRecord(args)) return undefined;
	if (args.action !== undefined || args.workflow !== undefined) return undefined;
	const toolCallId = stringField(value, "toolCallId");
	const agentName = stringField(args, "agent");
	if (!toolCallId || !agentName) return undefined;
	return {
		key: `tool:${toolCallId}`,
		agent: {
			agent: agentName,
			requestedModel: stringField(args, "model"),
			requestedAt: Date.now(),
			started: true,
			receivedProgress: false,
		},
	};
}

function applyProgressSnapshot(agent: ActiveSubagent, snapshot: Record<string, unknown>): void {
	agent.receivedProgress = true;
	agent.model = stringField(snapshot, "model");
	agent.currentTool = stringField(snapshot, "currentTool");
	agent.toolCount = typeof snapshot.toolCount === "number"
		&& Number.isFinite(snapshot.toolCount)
		&& snapshot.toolCount >= 0
		? snapshot.toolCount
		: undefined;
	agent.durationMs = typeof snapshot.durationMs === "number"
		&& Number.isFinite(snapshot.durationMs)
		&& snapshot.durationMs >= 0
		? snapshot.durationMs
		: undefined;
}

export function registerSubagentActivityStatus(pi: ExtensionAPI, options: {
	onActivityChange?: (busy: boolean, working: boolean) => void;
} = {}): void {
	const agents = new Map<string, ActiveSubagent>();
	const workflowAgents = new Map<string, ActiveSubagent>();
	const tools = new Map<string, { name: string; startedAt: number }>();
	let ui: StatusUI | undefined;
	let sessionActive = false;
	let startedAt: number | undefined;
	let phase = "Processing";
	let outcome = "completed";
	let promptDepth = 0;
	let notice: string | undefined;
	let lastStatus: string | undefined | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	let panelVisible = false;
	let panelCollapsed = false;
	let panelToggleUsed = false;
	let panelTui: TUI | undefined;
	let unsubscribeEvents: Array<() => void> = [];
	let lastBusy: boolean | undefined, lastWorking: boolean | undefined;
	let asyncStatusPending = false;
	let lastAsyncStatusAt = 0;
	let lastPublishedAgentActivity = "";
	const elapsed = (start: number): string => `${Math.max(0, Math.floor((Date.now() - start) / 1_000))}s`;
	const allAgents = (): Map<string, ActiveSubagent> => new Map([...agents, ...workflowAgents]);
	const publishAgentActivity = (): void => {
		const activity = [...allAgents()].map(([id, agent]) => ({ id, agent: agent.agent, currentTool: agent.currentTool }));
		const snapshot = JSON.stringify(activity);
		if (snapshot === lastPublishedAgentActivity) return;
		lastPublishedAgentActivity = snapshot;
		pi.events.emit("hypatia:research-agent-activity", activity);
	};
	const refreshPanel = (): void => {
		if (!ui?.setWidget) return;
		const visible = agents.size + workflowAgents.size > 0;
		if (visible === panelVisible) {
			if (visible) panelTui?.requestRender();
			return;
		}
		panelVisible = visible;
		if (!visible) {
			ui.setWidget(HINTS_WIDGET_KEY, undefined);
			panelTui = undefined;
			return;
		}
		ui.setWidget(HINTS_WIDGET_KEY, (tui, initialTheme) => {
			panelTui = tui;
			if (!panelToggleUsed) panelCollapsed = tui.terminal.columns < 60 || tui.terminal.rows < 22;
			return new AgentActivityPanel(tui, () => ui?.theme ?? initialTheme, () => [...allAgents().values()], () => panelCollapsed);
		}, { placement: "aboveEditor" });
	};
	const stopTimer = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const refreshAsyncDetails = (): void => {
		if (!workflowAgents.size || asyncStatusPending || Date.now() - lastAsyncStatusAt < 2_000) return;
		lastAsyncStatusAt = Date.now();
		asyncStatusPending = true;
		const requestId = randomUUID();
		const replyEvent = `subagents:rpc:v1:reply:${requestId}`;
		let finished = false;
		const finish = (reply?: unknown): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			unsubscribe();
			asyncStatusPending = false;
			if (!isRecord(reply) || reply.success !== true || !isRecord(reply.data)) return;
			const snapshot = reply.data.asyncSnapshot;
			const fleet = isRecord(reply.data.fleet) && Array.isArray(reply.data.fleet.entries) ? reply.data.fleet.entries : [];
			const nodes = new Map<string, Record<string, unknown>>();
			const visit = (value: unknown): void => {
				if (!isRecord(value)) return;
				if (value.kind === "step" || value.kind === "subagent") {
					const id = stringField(value, "id");
					if (id) nodes.set(id, value);
				}
				if (Array.isArray(value.children)) value.children.forEach(visit);
			};
			if (isRecord(snapshot) && Array.isArray(snapshot.runs)) snapshot.runs.forEach(visit);
			for (const agent of workflowAgents.values()) {
				const node = agent.snapshotId ? nodes.get(agent.snapshotId) : undefined;
				const activity = node && isRecord(node.activity) ? node.activity : undefined;
				const fleetEntry = fleet.filter((entry) => isRecord(entry) && entry.agent === agent.agent)
					.sort((left, right) => Math.abs(Number(left.startedAt) - agent.requestedAt) - Math.abs(Number(right.startedAt) - agent.requestedAt))[0];
				if (isRecord(fleetEntry)) agent.model = stringField(fleetEntry, "model");
				if (activity) {
					agent.currentTool = stringField(activity, "currentTool");
					agent.toolCount = typeof activity.toolCount === "number" && Number.isFinite(activity.toolCount) ? activity.toolCount : undefined;
				}
				agent.durationMs = Math.max(0, Date.now() - agent.requestedAt);
				agent.receivedProgress = Boolean(agent.model || agent.currentTool || activity);
			}
			updateStatus();
		};
		const unsubscribe = pi.events.on(replyEvent, finish) ?? (() => undefined);
		const timeout = setTimeout(() => finish(), 1_500);
		timeout.unref?.();
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
	};
	const updateStatus = (): void => {
		if (!sessionActive || !ui) return;
		const working = startedAt !== undefined || tools.size > 0 || agents.size > 0 || workflowAgents.size > 0;
		const busy = working || promptDepth > 0;
		if (busy !== lastBusy || working !== lastWorking) {
			lastBusy = busy; lastWorking = working;
			options.onActivityChange?.(busy, working);
		}
		const currentTool = [...tools.values()].at(-1);
		let mainStatus: string | undefined;
		if (promptDepth > 0) mainStatus = "Waiting for input";
		else if (currentTool) {
			const name = cleanStatusText(currentTool.name);
			mainStatus = `${toolPhase(currentTool.name)} · ${name}${tools.size > 1 ? ` · ${tools.size} active tools` : ""}`;
		} else if (startedAt !== undefined) mainStatus = phase;
		const clockStart = startedAt ?? currentTool?.startedAt;
		if (mainStatus && clockStart !== undefined) mainStatus += ` · ${elapsed(clockStart)}`;
		const status = [mainStatus ?? notice, formatStatus(allAgents())].filter(Boolean).join(" | ") || undefined;
		if (status !== lastStatus) {
			ui.setStatus(STATUS_KEY, status);
			lastStatus = status;
		}
		publishAgentActivity();
		if ((startedAt !== undefined || tools.size > 0 || agents.size > 0 || workflowAgents.size > 0) && timer === undefined) {
			timer = setInterval(updateStatus, 1_000);
			timer.unref?.();
		} else if (startedAt === undefined && tools.size === 0 && agents.size === 0 && workflowAgents.size === 0) stopTimer();
		refreshPanel();
		refreshAsyncDetails();
	};

	const stopListening = (): void => {
		for (const unsubscribe of unsubscribeEvents) unsubscribe();
		unsubscribeEvents = [];
	};

	const startListening = (): void => {
		stopListening();
		unsubscribeEvents = [
			pi.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (event) => {
				if (!isRecord(event)) return;
				const requestId = stringField(event, "requestId");
				const agent = stringField(event, "agent");
				if (!requestId || !agent) return;
				agents.set(requestId, {
					agent,
					requestedModel: stringField(event, "model"),
					requestedAt: Date.now(),
					started: false,
					receivedProgress: false,
				});
				updateStatus();
			}),
			pi.events.on(SUBAGENT_DELEGATION_STARTED_EVENT, (event) => {
				const requestId = requestIdField(event);
				const agent = requestId ? agents.get(requestId) : undefined;
				if (!agent) return;
				agent.started = true;
				updateStatus();
			}),
			pi.events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (event) => {
				if (!isRecord(event)) return;
				const requestId = stringField(event, "requestId");
				const agent = requestId ? agents.get(requestId) : undefined;
				if (!agent) return;
				applyProgressSnapshot(agent, event);
				updateStatus();
			}),
			pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, removeAgent),
			pi.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, removeAgent),
			pi.events.on(ASYNC_STARTED_EVENT, (event) => {
				if (!isRecord(event) || event.mode !== "single" || event.parentWorkflowRunId || event.workflowKey) return;
				const runId = stringField(event, "id") ?? stringField(event, "runId");
				const agent = stringField(event, "agent");
				if (!runId || !agent) return;
				const toolCallId = stringField(event, "toolCallId");
				if (toolCallId) agents.delete(`tool:${toolCallId}`);
				workflowAgents.set(`async:${runId}`, {
					agent,
					requestedAt: typeof event.startedAt === "number" ? event.startedAt : Date.now(),
					started: true,
					receivedProgress: false,
					snapshotId: runId,
					asyncRunId: runId,
				});
				updateStatus();
			}),
			pi.events.on(ASYNC_CHILD_STATUS_EVENT, (event) => {
				if (!isRecord(event) || event.source !== "async") return;
				const runId = stringField(event, "runId"), childId = stringField(event, "childId");
				if (!runId || !childId) return;
				const key = `${runId}:${childId}`;
				if (event.status === "stopped") workflowAgents.delete(key);
				else {
					const current = workflowAgents.get(key);
					workflowAgents.set(key, {
						agent: stringField(event, "agent") ?? "research agent",
						requestedAt: current?.requestedAt ?? (typeof event.ts === "number" ? event.ts : Date.now()),
						started: true, receivedProgress: false,
						snapshotId: stringField(event, "workflowKey") ?? childId,
						...(stringField(event, "childRunId") ? { asyncRunId: stringField(event, "childRunId") } : {}),
						...(current?.currentTool ? { currentTool: current.currentTool } : {}),
						...(current?.toolCount !== undefined ? { toolCount: current.toolCount } : {}),
					});
				}
				updateStatus();
			}),
			pi.events.on(ASYNC_COMPLETE_EVENT, (event) => {
				if (!isRecord(event)) return;
				const runId = stringField(event, "id") ?? stringField(event, "runId");
				if (runId) for (const [key, agent] of workflowAgents) {
					if (key === `async:${runId}` || agent.asyncRunId === runId || key.startsWith(`${runId}:`)) workflowAgents.delete(key);
				}
				updateStatus();
			}),
		];
	};

	const removeAgent = (event: unknown): void => {
		const requestId = requestIdField(event);
		if (!requestId || !agents.delete(requestId)) return;
		updateStatus();
	};

	pi.on("session_start", (_event, context) => {
		stopTimer();
		agents.clear();
		workflowAgents.clear();
		tools.clear();
		ui = sessionUi(context);
		sessionActive = Boolean(ui);
		startedAt = undefined;
		promptDepth = 0;
		notice = undefined;
		lastStatus = null;
		lastBusy = undefined; lastWorking = undefined;
		panelCollapsed = false;
		panelToggleUsed = false;
		panelVisible = false;
		panelTui = undefined;
		lastPublishedAgentActivity = "";
		ui?.setWidget?.(HINTS_WIDGET_KEY, undefined);
		updateStatus();
		if (sessionActive) startListening();
		else stopListening();
	});
	pi.on("session_shutdown", () => {
		sessionActive = false;
		stopTimer();
		ui?.setStatus(STATUS_KEY, undefined);
		ui?.setWidget?.(HINTS_WIDGET_KEY, undefined);
		panelVisible = false;
		panelTui = undefined;
		ui = undefined;
		agents.clear();
		workflowAgents.clear();
		tools.clear();
		stopListening();
	});
	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Toggle the active research-agent panel",
		handler: (context) => {
			if (!sessionActive || !context.hasUI) return;
			if (agents.size + workflowAgents.size === 0) {
				context.ui.notify("No active research agents.", "info");
				return;
			}
			panelCollapsed = !panelCollapsed;
			panelToggleUsed = true;
			panelTui?.requestRender();
		},
	});

	pi.on("agent_start", () => {
		if (!sessionActive) return;
		startedAt ??= Date.now();
		phase = "Processing";
		outcome = "completed";
		notice = undefined;
		updateStatus();
	});
	pi.on("turn_start", () => {
		if (!sessionActive || startedAt === undefined) return;
		phase = "Processing";
		updateStatus();
	});
	pi.on("message_update", (event) => {
		if (!sessionActive || startedAt === undefined) return;
		const type = event.assistantMessageEvent.type;
		const next = type === "thinking_start" || type === "thinking_delta" ? "Thinking"
			: type === "text_start" || type === "text_delta" ? "Answering" : undefined;
		if (!next || phase === next) return;
		phase = next;
		updateStatus();
	});
	pi.on("agent_end", (event) => {
		if (!sessionActive || startedAt === undefined) return;
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.role === "assistant" && ["error", "aborted"].includes(lastAssistant.stopReason)) {
			outcome = lastAssistant.stopReason;
		}
		phase = "Finishing";
		tools.clear();
		updateStatus();
	});
	pi.on("agent_before_settle", (event) => {
		if (sessionActive) outcome = event.outcome;
	});
	pi.on("agent_settled", () => {
		if (!sessionActive) return;
		notice = startedAt !== undefined && outcome !== "completed"
			? `${outcome === "aborted" ? "Interrupted" : "Failed"} · ${elapsed(startedAt)}` : undefined;
		startedAt = undefined;
		tools.clear();
		// Background delegations can outlive the main turn; keep their observed status.
		for (const key of agents.keys()) if (key.startsWith("tool:")) agents.delete(key);
		updateStatus();
	});
	pi.on("ui_prompt_start", () => {
		if (!sessionActive) return;
		promptDepth += 1;
		updateStatus();
	});
	pi.on("ui_prompt_end", () => {
		if (!sessionActive) return;
		promptDepth = Math.max(0, promptDepth - 1);
		updateStatus();
	});
	pi.on("tool_execution_start", (event) => {
		if (!sessionActive) return;
		tools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
		notice = undefined;
		const call = directSubagentCall(event);
		if (call) agents.set(call.key, call.agent);
		updateStatus();
	});
	pi.on("tool_execution_update", (event) => {
		if (!sessionActive || event.toolName !== "subagent") return;
		const agent = agents.get(`tool:${event.toolCallId}`);
		const snapshot = progressSnapshot(event.partialResult);
		if (!agent || !snapshot) return;
		applyProgressSnapshot(agent, snapshot);
		updateStatus();
	});
	pi.on("tool_execution_end", (event) => {
		if (!sessionActive || !tools.delete(event.toolCallId)) return;
		if (event.toolName === "subagent") agents.delete(`tool:${event.toolCallId}`);
		phase = event.isError ? `Tool failed · ${cleanStatusText(event.toolName)}` : "Processing";
		updateStatus();
	});
}

function cleanStatusText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function toolPhase(name: string): string {
	if (["alpha_search", "hypatia_science_database_search", "web_search", "code_search"].includes(name)) return "Searching sources";
	if (["alpha_get_paper", "fetch_content", "get_search_content", "document_parse", "document_search", "read"].includes(name)) return "Reading sources";
	if (name === "subagent") return "Delegating";
	if (["write", "edit"].includes(name)) return "Writing file";
	return "Running tool";
}

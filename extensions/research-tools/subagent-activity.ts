import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "pi-subagents/delegation";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY = "hypatia-activity";
const HINTS_WIDGET_KEY = "hypatia-chat-hints";
const MAX_VISIBLE_AGENTS = 2;

type ActiveSubagent = {
	readonly agent: string;
	readonly requestedModel?: string;
	started: boolean;
	receivedProgress: boolean;
	model?: string;
	currentTool?: string;
	toolCount?: number;
	durationMs?: number;
};

type StatusUI = Pick<ExtensionUIContext, "setStatus"> & Partial<Pick<ExtensionUIContext, "setWidget">>;

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
	let unsubscribeEvents: Array<() => void> = [];
	let lastBusy: boolean | undefined, lastWorking: boolean | undefined;
	const elapsed = (start: number): string => `${Math.max(0, Math.floor((Date.now() - start) / 1_000))}s`;
	const stopTimer = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const updateStatus = (): void => {
		if (!sessionActive || !ui) return;
		const working = startedAt !== undefined || tools.size > 0 || agents.size > 0;
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
		const status = [mainStatus ?? notice, formatStatus(agents)].filter(Boolean).join(" | ") || undefined;
		if (status !== lastStatus) {
			ui.setStatus(STATUS_KEY, status);
			lastStatus = status;
		}
		if ((startedAt !== undefined || tools.size > 0) && timer === undefined) {
			timer = setInterval(updateStatus, 1_000);
			timer.unref?.();
		} else if (startedAt === undefined && tools.size === 0) stopTimer();
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
		tools.clear();
		ui = sessionUi(context);
		sessionActive = Boolean(ui);
		startedAt = undefined;
		promptDepth = 0;
		notice = undefined;
		lastStatus = null;
		lastBusy = undefined; lastWorking = undefined;
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
		ui = undefined;
		agents.clear();
		tools.clear();
		stopListening();
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

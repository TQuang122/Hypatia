import { stripVTControlCharacters } from "node:util";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentActivityOutcome, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DELEGATION_CANCEL_EVENT, SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT } from "pi-subagents/delegation";
import { scrubSecretsText } from "./secret-scrubber.js";

const TURN_ENTRY = "hypatia-turn-output";
const MODE_ENTRY = "hypatia-config-output";
const LIVE_WIDGET = "hypatia-turn-progress";
const MAX_RECORDED_OPERATIONS = 40;
const MAX_LIVE_LABELS = 3;

type OperationKind = "read" | "write" | "edit" | "search" | "delegate" | "other";
type Operation = { kind: OperationKind; label: string; failed: boolean; error?: string };
type TurnOutput = {
	version: 1;
	outcome: AgentActivityOutcome;
	startedAt: number;
	endedAt: number;
	toolCount: number;
	issues: number;
	turnError?: string;
	operations: Operation[];
	omitted: number;
};
type ModeOutput = { version: 1; from: "regular" | "fullscreen"; to: "regular" | "fullscreen"; appliedNow: boolean };
type ResearchStage = "search" | "read" | "synthesis" | "verification";
type ResearchProgress = {
	command: "lit" | "deepresearch";
	completed: Set<ResearchStage>;
	activeTools: Map<string, ResearchStage>;
	asyncVerificationLaunches: Set<string>;
	sources: Set<string>;
	verification: Set<string>;
	verificationRuns: Map<string, string>;
	delegatedStages: Map<string, ResearchStage>;
	seenEvidence: boolean;
};

const RESEARCH_STAGE_LABELS: Record<ResearchStage, string> = {
	search: "Search", read: "Read", synthesis: "Synthesize", verification: "Verify",
};

function researchCommand(text: string): ResearchProgress["command"] | undefined {
	const match = /^\/(lit|deepresearch)(?=\s|$)/u.exec(text.trimStart());
	return match?.[1] as ResearchProgress["command"] | undefined;
}

function researchToolStage(toolName: string, args: unknown): ResearchStage | undefined {
	if (["alpha_search", "hypatia_science_database_search", "web_search"].includes(toolName)) return "search";
	if (["alpha_get_paper", "fetch_content", "get_search_content", "document_parse", "read"].includes(toolName)) return "read";
	if (toolName === "subagent" && isRecord(args) && ["auditor", "critic"].includes(String(args.agent))) return "verification";
	return undefined;
}

function sourceKeys(value: unknown, callId: string): string[] {
	if (!isRecord(value)) return [];
	const groups = [value, ...["semantic", "keyword", "agentic"].map((key) => value[key]).filter(isRecord)];
	const keys: string[] = [];
	for (const group of groups) {
		if (!Array.isArray(group.results)) continue;
		for (const [index, item] of group.results.entries()) {
			if (!isRecord(item)) continue;
			const stable = [item.doi, item.arxivId, item.arxiv_id, item.pmid, item.pmcid, item.title, item.url, item.openalexId, item.paperId, item.id]
				.find((candidate) => (typeof candidate === "string" && candidate.trim()) || (typeof candidate === "number" && Number.isFinite(candidate)));
			keys.push(stable === undefined ? `${callId}:${index}` : String(stable).trim().toLocaleLowerCase());
		}
	}
	return keys;
}

function researchStageLine(progress: ResearchProgress, activeStage: ResearchStage | undefined, theme: Theme): string {
	return (["search", "read", "synthesis", "verification"] as const).map((stage) => {
		const label = RESEARCH_STAGE_LABELS[stage];
		if (stage === activeStage) return theme.fg("accent", `◌ ${label}`);
		if (progress.completed.has(stage)) return theme.fg("success", `✓ ${label}`);
		return theme.fg("dim", `· ${label}`);
	}).join(theme.fg("dim", "  ›  "));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: string, max = 180): string {
	const plain = scrubSecretsText(stripVTControlCharacters(value)).text
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	return truncateToWidth(plain, max, "…");
}

function argumentText(args: unknown, keys: string[]): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return safeText(value, 240);
	}
	return undefined;
}

function fileName(args: unknown): string | undefined {
	const path = argumentText(args, ["path", "file_path", "filePath", "filename", "file"]);
	const name = path?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
	return name ? safeText(name, 48) : undefined;
}

function operationLabel(toolName: string, args: unknown): { kind: OperationKind; label: string } {
	const file = fileName(args);
	if (toolName === "read") return { kind: "read", label: file ? `Read ${file}` : "Read file" };
	if (toolName === "write") return { kind: "write", label: file ? `Write ${file}` : "Write file" };
	if (toolName === "edit") return { kind: "edit", label: file ? `Edit ${file}` : "Edit file" };
	if (["grep", "find", "ls"].includes(toolName)) return { kind: "search", label: file ? `Explore ${file}` : "Explore files" };
	if (["alpha_search", "hypatia_science_database_search"].includes(toolName)) return { kind: "search", label: "Search scholarly sources" };
	if (["web_search", "code_search"].includes(toolName)) return { kind: "search", label: toolName === "code_search" ? "Search code" : "Search the web" };
	if (["alpha_get_paper", "fetch_content", "get_search_content", "document_parse"].includes(toolName)) {
		return { kind: "read", label: file ? `Read ${file}` : "Read source" };
	}
	if (toolName === "document_search") return { kind: "search", label: "Search documents" };
	if (toolName === "subagent") {
		const agent = argumentText(args, ["agent"]);
		return { kind: "delegate", label: agent ? `Delegate to ${agent}` : "Delegate research" };
	}
	if (toolName === "bash") return { kind: "other", label: "Run shell command" };
	const readable = safeText(toolName.replace(/^hypatia_/, "").replaceAll("_", " "), 52);
	return { kind: "other", label: readable ? `${readable[0]!.toUpperCase()}${readable.slice(1)}` : "Run tool" };
}

function errorDetail(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
	const text = value.content.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as { text: string }).text).join(" ");
	return text ? safeText(text, 180) : undefined;
}

function timeText(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function durationText(startedAt: number, endedAt: number): string {
	return `${Math.max(0, Math.round((endedAt - startedAt) / 1_000))}s`;
}

function turnTitle(data: TurnOutput): { text: string; color: "success" | "warning" | "error" } {
	if (data.outcome === "aborted") return { text: "Interrupted", color: "warning" };
	if (data.outcome === "error") return { text: "Failed", color: "error" };
	return { text: "Done", color: "success" };
}

function summarizeOperations(operations: Operation[], toolCount: number): string {
	const files = [...new Set(operations.filter((item) => ["read", "write", "edit"].includes(item.kind)).map((item) => item.label))];
	const searches = operations.filter((item) => item.kind === "search").length;
	const delegates = operations.filter((item) => item.kind === "delegate").length;
	const groups = [
		files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : undefined,
		searches ? `${searches} search${searches === 1 ? "" : "es"}` : undefined,
		delegates ? `${delegates} delegation${delegates === 1 ? "" : "s"}` : undefined,
	].filter((item): item is string => Boolean(item));
	return `Explored · ${toolCount} operation${toolCount === 1 ? "" : "s"}${groups.length ? ` · ${groups.join(" · ")}` : ""}`;
}

function activeToolStage(operations: Operation[]): string {
	const kinds = new Set(operations.map((operation) => operation.kind));
	if (kinds.size !== 1) return "Exploring";
	switch (operations[0]?.kind) {
		case "search": return "Searching";
		case "read": return "Reading";
		case "write":
		case "edit": return "Writing";
		case "delegate": return "Delegating";
		default: return "Running tool";
	}
}

function line(text: string, color: Parameters<Theme["fg"]>[0], theme: Theme, padding: number): Text {
	return new Text(theme.fg(color, text), padding, 0);
}

function makeTurnEntry(data: TurnOutput, expanded: boolean, theme: Theme, width: number, padding: number): string[] {
	const root = new Container();
	const title = turnTitle(data);
	root.addChild(line(`${title.text} · ${durationText(data.startedAt, data.endedAt)} · ${timeText(data.endedAt)}`, title.color, theme, padding));
	if (data.operations.length === 0 && data.issues === 0) {
		root.addChild(line("No tools used", "dim", theme, padding));
		return root.render(width);
	}
	root.addChild(line(`${summarizeOperations(data.operations, data.toolCount)}${data.issues ? ` · ${data.issues} issue${data.issues === 1 ? "" : "s"}` : ""}`, data.issues ? "warning" : "muted", theme, padding));
	if (!expanded && (data.issues > 0 || data.outcome === "error")) {
		const failedOperation = data.operations.find((operation) => operation.failed);
		const failure = data.turnError
			?? (failedOperation?.error ? `${failedOperation.label}: ${failedOperation.error}` : undefined)
			?? (failedOperation ? `${failedOperation.label} failed` : `${data.issues || 1} tool issue${data.issues === 1 ? "" : "s"}`);
		root.addChild(line(truncateToWidth(`⚠ ${failure}`, Math.max(1, width - padding * 2), "…"), "error", theme, padding));
	}
	if (expanded) {
		for (const operation of data.operations) {
			root.addChild(line(`${operation.failed ? "✗" : "✓"} ${operation.label}`, operation.failed ? "error" : "dim", theme, padding + 1));
			if (operation.error) root.addChild(line(`  ${operation.error}`, "muted", theme, padding + 1));
		}
		if (data.turnError) root.addChild(line(`✗ ${data.turnError}`, "error", theme, padding + 1));
		if (data.omitted > 0) root.addChild(line(`… ${data.omitted} more operations`, "dim", theme, padding + 1));
	} else if (data.issues > 0 || data.operations.length > 0) {
		root.addChild(line(`Ctrl+O to ${data.issues ? "expand activity and errors" : "expand activity"}`, "dim", theme, padding));
	} else if (data.turnError) {
		root.addChild(line("Ctrl+O to expand the error", "dim", theme, padding));
	}
	return root.render(width);
}

function makeModeEntry(data: ModeOutput, theme: Theme, width: number, padding: number): string[] {
	const mode = data.to === "fullscreen" ? "Fullscreen" : "Regular";
	const message = data.appliedNow
		? `TUI mode: ${mode} · Applied immediately; restart not required.`
		: `Saved TUI mode: ${mode} · This session still uses ${data.from === "fullscreen" ? "Fullscreen" : "Regular"}. Restart Hypatia to apply.`;
	const root = new Container();
	root.addChild(line(message, data.appliedNow ? "accent" : "warning", theme, padding));
	return root.render(width);
}

function isTurnOutput(value: unknown): value is TurnOutput {
	return isRecord(value) && value.version === 1 && ["completed", "error", "aborted"].includes(String(value.outcome))
		&& typeof value.startedAt === "number" && typeof value.endedAt === "number"
		&& typeof value.toolCount === "number" && typeof value.issues === "number"
		&& (value.turnError === undefined || typeof value.turnError === "string")
		&& Array.isArray(value.operations) && typeof value.omitted === "number";
}

function isModeOutput(value: unknown): value is ModeOutput {
	return isRecord(value) && value.version === 1 && ["regular", "fullscreen"].includes(String(value.from))
		&& ["regular", "fullscreen"].includes(String(value.to)) && typeof value.appliedNow === "boolean";
}

export function registerChatTurnOutput(pi: ExtensionAPI): { setActivity(busy: boolean, working: boolean): void } {
	let context: ExtensionContext | undefined;
	let startedAt: number | undefined;
	let phase = "Thinking";
	let outcome: AgentActivityOutcome = "completed";
	let toolCount = 0, issues = 0, omitted = 0, turnError: string | undefined;
	let pendingFinish = false, liveWidgetVisible = false;
	let operations: Operation[] = [];
	let activeToolOperations = new Map<string, Operation>();
	let pendingResearchCommand: ResearchProgress["command"] | undefined;
	let research: ResearchProgress | undefined;
	let activeResearchStage: ResearchStage | undefined;
	let unsubscribeResearchEvents: Array<() => void> = [];
	let requestLiveRender: (() => void) | undefined;
	const MAX_OPERATIONS = 40;
	const setLiveWidget = (show: boolean): void => {
		if (!context || context.mode !== "tui" || !context.hasUI) return;
		if (liveWidgetVisible === show) { if (show) requestLiveRender?.(); return; }
		liveWidgetVisible = show;
		if (!show) { requestLiveRender = undefined; context.ui.setWidget(LIVE_WIDGET, undefined); return; }
		context.ui.setWidget(LIVE_WIDGET, (tui, initialTheme) => {
			requestLiveRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0 || startedAt === undefined) return [];
					const activeTheme = context?.ui.theme ?? initialTheme;
					const activeOperations = [...activeToolOperations.values()];
					if (research) {
						const active = [...research.activeTools.values(), ...research.delegatedStages.values()];
						const stage = active.includes("verification") || research.verification.size ? "verification" : active.includes("read") ? "read" : active.includes("search") ? "search" : activeResearchStage;
						const title = `${research.command === "lit" ? "/lit" : "/deepresearch"} · ${research.sources.size} parent-visible sources${issues ? ` · ${issues} issue${issues === 1 ? "" : "s"}` : ""}`;
						return [
							new Text(activeTheme.fg("accent", truncateToWidth(title, width, "…")), 1, 0).render(width)[0] ?? "",
							new Text(truncateToWidth(researchStageLine(research, stage, activeTheme), width, "…"), 1, 0).render(width)[0] ?? "",
						];
					}
					const labels = [...new Set(activeOperations.map((item) => item.label))].slice(-MAX_LIVE_LABELS);
					const activity = activeOperations.length ? activeToolStage(activeOperations) : phase;
					const toolsText = activeOperations.length
						? `${activeOperations.length} active tool${activeOperations.length === 1 ? "" : "s"}`
						: toolCount ? `${toolCount} operation${toolCount === 1 ? "" : "s"}` : "";
					const issueText = issues ? ` · ${issues} issue${issues === 1 ? "" : "s"}` : "";
					const detail = labels.length ? ` · ${labels.join(" · ")}` : "";
					const count = toolsText ? ` · ${toolsText}` : "";
					const text = truncateToWidth(`${activity}${count}${detail}${issueText}`, Math.max(0, width - 2), "…");
					return new Text(activeTheme.fg(issues ? "warning" : "accent", text), 1, 0).render(width);
				},
			};
		}, { placement: "aboveEditor" });
	};
	const observeVerification = (agent: unknown, key: string, runId?: string): void => {
		if (!research || !["auditor", "critic"].includes(String(agent))) return;
		research.verification.add(key);
		if (runId) research.verificationRuns.set(runId, key);
		if (activeResearchStage === "synthesis") research.completed.add("synthesis");
		activeResearchStage = "verification";
		setLiveWidget(true);
	};
	const observeResearchEvents = (): void => {
		for (const unsubscribe of unsubscribeResearchEvents) unsubscribe();
		unsubscribeResearchEvents = [
			pi.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (event) => {
				if (isRecord(event) && typeof event.requestId === "string") observeVerification(event.agent, event.requestId);
			}),
			pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (event) => {
				if (!isRecord(event) || !research?.verification.delete(String(event.requestId ?? ""))) return;
				if (event.status === "completed") research.completed.add("verification");
				if (!research.verification.size) activeResearchStage = undefined;
				setLiveWidget(true);
			}),
			pi.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (event) => {
				if (!isRecord(event) || !research?.verification.delete(String(event.requestId ?? ""))) return;
				if (!research.verification.size) activeResearchStage = undefined;
				setLiveWidget(true);
			}),
			pi.events.on("subagent:child-status", (event) => {
				if (!isRecord(event)) return;
				const runId = typeof event.runId === "string" ? event.runId : "";
				const childId = typeof event.childId === "string" ? event.childId : "";
				if (!runId || !childId) return;
				const key = `child:${runId}:${childId}`;
				if (event.status === "started") observeVerification(event.agent, key, typeof event.childRunId === "string" ? event.childRunId : undefined);
				else if (event.status === "stopped" && research?.verification.delete(key)) {
					const childRunId = typeof event.childRunId === "string" ? event.childRunId : undefined;
					if (childRunId) research.verificationRuns.delete(childRunId);
					if (!research.verification.size) activeResearchStage = undefined;
					setLiveWidget(true);
				}
			}),
			pi.events.on("hypatia:research-agent-activity", (event) => {
				if (!research || !Array.isArray(event)) return;
				const next = new Map<string, ResearchStage>();
				for (const row of event) {
					if (!isRecord(row) || typeof row.id !== "string" || typeof row.currentTool !== "string") continue;
					const stage = researchToolStage(row.currentTool, undefined);
					if (stage === "search" || stage === "read") next.set(row.id, stage);
				}
				for (const [id, stage] of research.delegatedStages) {
					if (next.get(id) !== stage && ![...next.values()].includes(stage)) {
						research.completed.add(stage);
						research.seenEvidence = true;
					}
				}
				research.delegatedStages = next;
				setLiveWidget(true);
			}),
			pi.events.on("subagent:async-started", (event) => {
				if (!isRecord(event) || typeof event.id !== "string") return;
				observeVerification(event.agent, `async:${event.id}`, event.id);
			}),
			pi.events.on("subagent:async-complete", (event) => {
				if (!isRecord(event) || !research) return;
				const runId = typeof event.id === "string" ? event.id : typeof event.runId === "string" ? event.runId : "";
				const key = research.verificationRuns.get(runId);
				if (!key) return;
				research.verificationRuns.delete(runId);
				research.verification.delete(key);
				if (event.state === "complete") research.completed.add("verification");
				if (!research.verification.size) activeResearchStage = undefined;
				setLiveWidget(true);
			}),
		];
	};
	const finish = (busy: boolean, working: boolean): void => {
		if (!pendingFinish || busy || working || startedAt === undefined) return;
		pendingFinish = false;
		setLiveWidget(false);
		const endedAt = Date.now();
		const summary: TurnOutput = {
			version: 1, outcome, startedAt, endedAt, toolCount,
			issues: Math.max(issues, outcome === "error" ? 1 : 0),
			...(turnError ? { turnError } : {}), operations, omitted,
		};
		const hasActivity = toolCount > 0 || operations.length > 0;
		if (hasActivity || outcome !== "completed" || summary.issues > 0 || summary.turnError) {
			pi.appendEntry(TURN_ENTRY, summary);
		}
		startedAt = undefined;
		research = undefined;
		activeResearchStage = undefined;
	};

	pi.registerEntryRenderer(TURN_ENTRY, (entry, options, theme) => {
		const data = entry.data;
		if (!isTurnOutput(data)) return undefined;
		return new (class {
			invalidate() {}
			render(width: number): string[] { return makeTurnEntry(data, options.expanded, theme, width, 1); }
		})();
	});
	pi.registerEntryRenderer(MODE_ENTRY, (entry, _options, theme) => {
		const data = entry.data;
		if (!isModeOutput(data)) return undefined;
		return new (class {
			invalidate() {}
			render(width: number): string[] { return makeModeEntry(data, theme, width, 1); }
		})();
	});

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		startedAt = undefined; pendingFinish = false; liveWidgetVisible = false; pendingResearchCommand = undefined; research = undefined; activeResearchStage = undefined;
		requestLiveRender = undefined;
		for (const unsubscribe of unsubscribeResearchEvents) unsubscribe();
		unsubscribeResearchEvents = [];
		operations = []; activeToolOperations.clear(); toolCount = 0; issues = 0; omitted = 0; turnError = undefined;
		if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget(LIVE_WIDGET, undefined);
	});
	pi.on("input", (event) => {
		if (!event.streamingBehavior) pendingResearchCommand = researchCommand(event.text);
	});
	pi.on("agent_start", () => {
		if (context?.mode !== "tui" || !context.hasUI) return;
		if (startedAt === undefined) {
			startedAt = Date.now(); outcome = "completed";
				operations = []; activeToolOperations.clear(); toolCount = 0; issues = 0; omitted = 0; turnError = undefined;
				research = pendingResearchCommand ? {
				command: pendingResearchCommand, completed: new Set(), activeTools: new Map(), asyncVerificationLaunches: new Set(), sources: new Set(), verification: new Set(), verificationRuns: new Map(), delegatedStages: new Map(), seenEvidence: false,
			} : undefined;
			activeResearchStage = undefined;
		}
		pendingResearchCommand = undefined;
		if (research) observeResearchEvents();
		pendingFinish = false; phase = "Thinking"; setLiveWidget(true);
	});
	pi.on("message_update", (event) => {
		if (startedAt === undefined) return;
		const type = event.assistantMessageEvent.type;
		if (type === "thinking_start" || type === "thinking_delta") phase = "Thinking";
		else if (type === "text_start" || type === "text_delta") {
			phase = "Answering";
			if (research?.seenEvidence && !research.activeTools.size && !research.verification.size) activeResearchStage = "synthesis";
		}
		else return;
		setLiveWidget(true);
	});
	pi.on("tool_execution_start", (event) => {
		if (startedAt === undefined || event.parentToolCallId) return;
			toolCount += 1;
			const described = operationLabel(event.toolName, event.args);
			const operation: Operation = { ...described, failed: false };
			operations.push(operation);
			activeToolOperations.set(event.toolCallId, operation);
		const researchStage = researchToolStage(event.toolName, event.args);
		if (research && researchStage) {
			research.activeTools.set(event.toolCallId, researchStage);
			if (researchStage === "verification") {
				research.verification.add(event.toolCallId);
				if (isRecord(event.args) && event.args.async === true) research.asyncVerificationLaunches.add(event.toolCallId);
				if (activeResearchStage === "synthesis") research.completed.add("synthesis");
			}
			activeResearchStage = researchStage;
		}
			if (operations.length > MAX_OPERATIONS) {
				operations.shift(); omitted += 1;
				const retained = new Set(operations);
				for (const [id, active] of activeToolOperations) if (!retained.has(active)) activeToolOperations.delete(id);
			}
		phase = "Exploring"; setLiveWidget(true);
	});
	pi.on("tool_execution_end", (event) => {
		if (startedAt === undefined || event.parentToolCallId) return;
			const operation = activeToolOperations.get(event.toolCallId);
			activeToolOperations.delete(event.toolCallId);
			if (event.isError) {
				issues += 1;
				if (operation) operation.failed = true;
				const detail = errorDetail(event.result);
				if (detail && operation) operation.error = detail;
			} else if (operation) operation.failed = false;
		if (research) {
			const stage = research.activeTools.get(event.toolCallId);
			if (stage) {
				research.activeTools.delete(event.toolCallId);
				if (stage === "verification") {
					research.verification.delete(event.toolCallId);
					if (!event.isError && !research.asyncVerificationLaunches.delete(event.toolCallId)) research.completed.add("verification");
				}
				if (!event.isError && stage !== "verification") {
					research.completed.add(stage);
					research.seenEvidence = true;
				}
				if (stage === "search" && !event.isError) {
					const details = isRecord(event.result) ? event.result.details : undefined;
					for (const key of sourceKeys(details, event.toolCallId)) research.sources.add(key);
				}
				if (!research.activeTools.size && !research.verification.size) activeResearchStage = undefined;
			}
		}
		if (activeToolOperations.size === 0) phase = "Thinking";
		setLiveWidget(true);
	});
	pi.on("agent_before_settle", (event) => { if (startedAt !== undefined) outcome = event.outcome; });
	pi.on("agent_end", (event) => {
		if (startedAt === undefined) return;
		phase = "Finishing";
		if (research && activeResearchStage === "synthesis") research.completed.add("synthesis");
		setLiveWidget(true);
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted") outcome = "aborted";
		else if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
			outcome = "error";
			turnError = typeof lastAssistant.errorMessage === "string" ? safeText(lastAssistant.errorMessage) : undefined;
		}
	});
	pi.on("agent_settled", () => {
		if (startedAt === undefined) return;
		pendingFinish = true;
	});
	pi.on("session_shutdown", () => {
		if (context?.mode === "tui" && context.hasUI) context.ui.setWidget(LIVE_WIDGET, undefined);
		requestLiveRender = undefined;
		for (const unsubscribe of unsubscribeResearchEvents) unsubscribe();
		unsubscribeResearchEvents = [];
		context = undefined; liveWidgetVisible = false;
	});
	return { setActivity: (busy, working) => finish(busy, working) };
}

export function registerTuiModeNotices(pi: ExtensionAPI): { observeRuntimeMode(mode: "regular" | "fullscreen"): void } {
	let context: ExtensionContext | undefined;
	let configuredMode: "regular" | "fullscreen" = "regular";
	let activeMode: "regular" | "fullscreen" | undefined;
	let unsubscribe: (() => void) | undefined;
	let generation = 0;
	const append = (from: "regular" | "fullscreen", to: "regular" | "fullscreen", appliedNow: boolean): void => {
		if (!appliedNow && context?.sessionManager.getBranch().some((entry) =>
			entry.type === "custom" && entry.customType === MODE_ENTRY && isModeOutput(entry.data)
			&& entry.data.from === from && entry.data.to === to && !entry.data.appliedNow)) return;
		pi.appendEntry(MODE_ENTRY, { version: 1, from, to, appliedNow } satisfies ModeOutput);
	};
	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.(); unsubscribe = undefined;
		++generation; context = ctx;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		configuredMode = pi.getSettings().tuiMode === "fullscreen" ? "fullscreen" : "regular";
		activeMode = undefined;
		const epoch = generation;
		unsubscribe = ctx.ui.onTerminalInput((input) => {
			// Settings choices are selected with Enter, arrows, Space or the mouse.
			// Ordinary editor text does not require cloning the effective settings.
			if (!(input === "\r" || input === "\n" || /^\x1b\[</u.test(input)
				|| input.startsWith("\x1b[M") || input === "\x1b[A" || input === "\x1b[B"
				|| input === "\x1b[C" || input === "\x1b[D" || input === " ")) return undefined;
			queueMicrotask(() => {
				if (epoch !== generation || context !== ctx) return;
				const next = pi.getSettings().tuiMode === "fullscreen" ? "fullscreen" : "regular";
				if (next === configuredMode) return;
				const previous = configuredMode;
				configuredMode = next;
				// Pi switches the renderer before setting the effective and persisted
				// value, so a changed value here means this selection applied live.
				activeMode = next;
				append(previous, next, true);
			});
			return undefined;
		});
	});
	const observeRuntimeMode = (mode: "regular" | "fullscreen"): void => {
		const previousActiveMode = activeMode;
		activeMode = mode;
		const current = context;
		if (!current || current.mode !== "tui" || !current.hasUI) return;
		const preferred = pi.getSettings().tuiMode === "fullscreen" ? "fullscreen" : "regular";
		if (preferred === mode || (previousActiveMode === mode && configuredMode === preferred)) return;
		append(mode, preferred, false);
	};
	pi.on("session_shutdown", () => {
		++generation; unsubscribe?.(); unsubscribe = undefined; context = undefined;
	});
	return { observeRuntimeMode };
}

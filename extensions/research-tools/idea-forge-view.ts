import { getMarkdownTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult, type TUI } from "@earendil-works/pi-tui";
import type { Generation, IdeaChoice } from "../../src/idea-forge/types.js";

type ReaderTUI = Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
function plain(value: unknown, max = 12000): string {
	return (typeof value === "string" ? value : "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, max).trim();
}
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(item => {
		if (typeof item === "string") return plain(item);
		const finding = record(item), title = plain(finding.title ?? finding.category ?? finding.severity, 160);
		const detail = plain(finding.detail ?? finding.message ?? finding.reason, 800);
		return [title, detail].filter(Boolean).join(": ");
	}).filter(Boolean) : [];
export function formatIdeaProposal(run: Generation, idea: IdeaChoice): string {
	const validation = record(idea.validation), consensus = record(idea.consensus);
	const direction = run.spec.backend.directions.find(item => item.id === idea.direction)?.title ?? idea.direction;
	const findings = list(validation.findings);
	const lines = [
		`# Proposal ${idea.index} · ${plain(idea.title, 300) || run.spec.topic}`,
		"**Status:** unverified research proposal · model review is advisory",
		"",
		"## Research idea",
		plain(idea.idea) || "No separate idea statement was returned; see the proposed plan.",
		"",
		"## Proposed plan",
		plain(idea.plan) || "No plan was returned.",
		"",
		"## Context",
		`- Topic: ${plain(run.spec.topic, 500)}`,
		`- Signal: ${plain(run.spec.signal, 1500)}`,
		`- Knowledge: ${plain(direction, 200)}`,
		`- Source: ${plain(run.spec.sourceUrl, 500) || "User-provided signal; not independently verified"}`,
		`- Proposing model: ${plain(idea.sourceModel, 200) || "not reported"}`,
		"",
		"## Advisory review",
		`- Verdict: ${plain(validation.verdict ?? (typeof idea.validation === "string" ? idea.validation : undefined), 80) || "not reported"}${validation.advisory === true ? " · advisory only" : ""}`,
		`- Reviewer: ${plain(consensus.reviewer, 200) || "not reported"}`,
		`- Independent model: ${consensus.independent === true ? "yes (configured identity)" : consensus.independent === false ? "no" : "unknown"}`,
		...(plain(validation.summary ?? (typeof idea.validation === "string" ? idea.validation : undefined)) ? ["", plain(validation.summary ?? idea.validation, 1500)] : []),
		...(findings.length ? ["", "### Findings", ...findings.map(finding => `- ${finding}`)] : []),
		"",
		"> Verify sources, compute requirements, split protocol and metric before creating a benchmark contract. Selecting this proposal does not run a benchmark.",
	];
	return lines.join("\n");
}

export function formatGenerationStatus(run: Generation, status: {
	requestCount?: number; completedRequests?: number; failedRequests?: number; responseCacheCount?: number;
	proposalCount?: number; integrity?: string; receipts?: string[];
}): string {
	const direction = run.spec.backend.directions.find(item => item.id === run.spec.direction)?.title ?? run.spec.direction;
	return [
		`# Idea Forge · ${run.spec.slug}`,
		`**State:** ${run.state.status} · updated ${new Date(run.state.updatedAt).toLocaleString()}`,
		"",
		"## Request and time budget",
		`- Reserved: ${status.requestCount ?? "unavailable"}/${run.spec.maxRequests}`,
		`- Completed: ${status.completedRequests ?? "unavailable"} · failed/interrupted: ${status.failedRequests ?? "unavailable"}`,
		`- Completed responses cached: ${status.responseCacheCount ?? "unavailable"}`,
		`- Charged worker time: ${(run.state.spentMs / 1000).toFixed(1)}s/${run.spec.maxWallSeconds}s`,
		...(status.proposalCount !== undefined ? [`- Proposals: ${status.proposalCount} · unverified`] : []),
		`- Evidence integrity: ${status.integrity ?? "not checked"}`,
		"",
		"## Contract",
		`- Topic: ${plain(run.spec.topic, 500)}`,
		`- Knowledge: ${plain(direction, 200)}`,
		`- Models: ${run.spec.modelPanel.map(model => plain(model, 200)).join(", ")}`,
		`- Source: ${plain(run.spec.sourceUrl, 500) || "user-provided signal; not independently verified"}`,
		"",
		"## Latest state",
		plain(run.state.message, 1600) || "No additional status message.",
		...(status.receipts?.length ? ["", "## Receipts", ...status.receipts.map(receipt => `- ${receipt}`)] : []),
		"",
		`Artifacts: experiments/idea-forge/${run.spec.slug}/`,
	].join("\n");
}

export function formatGenerationApproval(run: Generation, inferred: readonly string[]): string {
	const direction = run.spec.backend.directions.find(item => item.id === run.spec.direction)?.title ?? run.spec.direction;
	const expectedRequests = run.spec.modelPanel.length * 3;
	const budgetWarning = run.spec.maxRequests < expectedRequests
		? `> **Budget may be too low:** a full ${run.spec.modelPanel.length}-model panel can require up to ${expectedRequests} requests; this contract allows ${run.spec.maxRequests}.`
		: `> A full panel may use up to ${expectedRequests} requests; this contract allows ${run.spec.maxRequests}.`;
	return [
		`# ${plain(run.spec.slug, 120)} · generation contract`,
		"**State:** planned · approval starts Idea Forge model calls only",
		"",
		"## Research goal",
		plain(run.spec.topic, 1800) || "No topic supplied.",
		"",
		"## Scope and constraints",
		plain(run.spec.signal, 3200) || "No signal supplied.",
		"",
		"## Model panel and guidance",
		`- Panel: ${run.spec.modelPanel.map(model => `\`${plain(model, 200)}\``).join(", ")}`,
		`- Review: ${run.spec.modelPanel.length === 1 ? "single-model critique; not independent" : "distinct model identities; reviews are advisory"}`,
		`- Knowledge: ${plain(direction, 300)}${run.spec.knowledgePath ? ` · ${plain(run.spec.knowledgePath, 400)}` : " · built-in guidance"}`,
		`- Source: ${plain(run.spec.sourceUrl, 600) || "user-provided signal; not independently verified"}`,
		"",
		"## Resources",
		plain(run.spec.resourceDescription, 1400) || "Unspecified; treat availability as unverified.",
		"",
		"## Limits",
		`- Requests: **${run.spec.maxRequests} attempts** · expected full-panel ceiling: ${expectedRequests}`,
		`- Time: **${run.spec.maxWallSeconds}s** total · ${run.spec.requestTimeoutSeconds}s per request`,
		`- Output: **${run.spec.maxTokens} tokens** per request`,
		budgetWarning,
		...(inferred.length ? [`- Inferred fields: ${inferred.map(field => `\`${plain(field, 100)}\``).join(", ")}`] : ["- Inferred fields: none"]),
		"",
		"> This approval covers idea-generation model calls only. It does **not** run a benchmark; a benchmark requires its own contract and approval.",
		"",
		`Artifacts: \`experiments/idea-forge/${plain(run.spec.slug, 120)}/\``,
	].join("\n");
}

class IdeaForgeApproval implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (approved: boolean) => void;
	private readonly document: Markdown;
	private rows: string[] = [];
	private cachedWidth = -1;
	private scrollTop = 0;
	private pageHeight = 8;
	private action: "approve" | "cancel" = "approve";

	constructor(tui: TUI, theme: Theme, content: string, done: (approved: boolean) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.document = new Markdown(content, 0, 0, getMarkdownTheme());
	}

	invalidate(): void { this.document.invalidate(); this.cachedWidth = -1; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(false); return; }
		if (matchesKey(data, Key.left) || matchesKey(data, "a") || matchesKey(data, "y")) this.action = "approve";
		else if (matchesKey(data, Key.right) || matchesKey(data, "c") || matchesKey(data, "n")) this.action = "cancel";
		else if (matchesKey(data, Key.enter)) { this.done(this.action === "approve"); return; }
		else if (matchesKey(data, Key.down)) this.scrollTop++;
		else if (matchesKey(data, Key.up)) this.scrollTop--;
		else if (matchesKey(data, Key.pageDown)) this.scrollTop += Math.max(1, this.pageHeight - 2);
		else if (matchesKey(data, Key.pageUp)) this.scrollTop -= Math.max(1, this.pageHeight - 2);
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = this.rows.length;
		else return;
		this.clamp();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		this.scrollTop += event.wheelDelta;
		this.clamp();
		return { handled: true, render: true };
	}

	private clamp(): void {
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.rows.length - this.pageHeight)));
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const innerWidth = Math.max(1, width - 2);
		const fit = (row: string) => truncateToWidth(row, innerWidth, innerWidth > 1 ? "…" : "");
		if (this.cachedWidth !== innerWidth) {
			this.rows = this.document.render(innerWidth).map(fit);
			if (!this.rows.length) this.rows = ["(empty contract)"];
			this.cachedWidth = innerWidth;
		}
		this.pageHeight = Math.max(3, Math.min(16, this.tui.terminal.rows - 17));
		this.clamp();
		const body = this.rows.slice(this.scrollTop, this.scrollTop + this.pageHeight);
		while (body.length < this.pageHeight) body.push("");
		const position = `${this.scrollTop + 1}–${Math.min(this.scrollTop + this.pageHeight, this.rows.length)}/${this.rows.length}`;
		const button = (label: string, active: boolean) => this.theme.style(` ${label} `, {
			fg: "text",
			bg: active ? this.theme.colors.accent : this.theme.colors.customMessageBg,
			bold: active,
		});
		const actions = `${button("Approve", this.action === "approve")}  ${button("Cancel", this.action === "cancel")}   ${this.theme.fg("dim", "←→ choose · Enter confirm · Esc cancel")}`;
		const surface = (value: string) => {
			const text = fit(value), padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
			return this.theme.style(` ${text}${padding} `, { bg: this.theme.colors.customMessageBg });
		};
		const border = (left: string, right: string) => this.theme.style(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`, { fg: "accent", bg: this.theme.colors.customMessageBg });
		return [
			border("╭", "╮"),
			surface(this.theme.fg("accent", this.theme.bold("Idea Forge · Review generation contract"))),
			...body.map(surface),
			surface(this.theme.fg("dim", `${position} lines · ↑↓/Pg scroll · Home/End`)),
			surface(actions),
			border("╰", "╯"),
		];
	}
}

export type IdeaForgeApprovalUI = Pick<ExtensionCommandContext["ui"], "custom">;
export async function showIdeaForgeApproval(ui: IdeaForgeApprovalUI, run: Generation, inferred: readonly string[]): Promise<boolean> {
	const content = formatGenerationApproval(run, inferred);
	return (await ui.custom<boolean>((tui, theme, _keys, done) => new IdeaForgeApproval(tui, theme, content, done), {
		overlay: true,
		overlayOptions: { anchor: "bottom-center", width: "96%", maxHeight: "60%", offsetY: -6, margin: { left: 1, right: 1, top: 1, bottom: 1 } },
	})) === true;
}

export class IdeaForgeReader implements Component {
	private document: Markdown;
	private rows: string[] = [];
	private width = -1;
	private scrollTop = 0;
	private pageHeight = 16;
	private readonly title: string;
	private readonly tui: ReaderTUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	constructor(tui: ReaderTUI, theme: Theme, title: string, markdown: string, done: () => void) {
		this.tui = tui; this.theme = theme; this.title = plain(title, 300); this.done = done;
		this.document = new Markdown(markdown, 0, 0, getMarkdownTheme());
	}
	invalidate(): void { this.document.invalidate(); this.width = -1; }
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(); return; }
		const page = Math.max(1, this.pageHeight - 2);
		if (matchesKey(data, Key.down)) this.scrollTop++;
		else if (matchesKey(data, Key.up)) this.scrollTop--;
		else if (matchesKey(data, Key.pageDown)) this.scrollTop += page;
		else if (matchesKey(data, Key.pageUp)) this.scrollTop -= page;
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = this.rows.length;
		else return;
		this.clamp(); this.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		this.scrollTop += event.wheelDelta; this.clamp(); return { handled: true, render: true };
	}
	private clamp(): void { this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.rows.length - this.pageHeight))); }
	render(width: number): string[] {
		if (width <= 0) return [];
		const horizontalPadding = width >= 3 ? 1 : 0;
		const contentWidth = Math.max(1, width - horizontalPadding * 2), fit = (row: string) => truncateToWidth(row, contentWidth, contentWidth > 1 ? "…" : "");
		const surface = (value: string) => {
			const text = fit(value), padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(text)));
			return this.theme.style(`${" ".repeat(horizontalPadding)}${text}${padding}${" ".repeat(horizontalPadding)}`, { bg: this.theme.colors.customMessageBg });
		};
		this.pageHeight = Math.max(1, this.tui.terminal.rows - 5);
		if (this.width !== contentWidth) { this.rows = this.document.render(contentWidth).map(fit); if (!this.rows.length) this.rows = ["(empty)"]; this.width = contentWidth; }
		this.clamp();
		const accent = this.theme.fg("accent", this.theme.bold(this.title));
		const body = this.rows.slice(this.scrollTop, this.scrollTop + this.pageHeight).map(row => ` ${row}`);
		while (body.length < this.pageHeight) body.push("");
		const position = `${this.scrollTop + 1}–${Math.min(this.scrollTop + this.pageHeight, this.rows.length)}/${this.rows.length} lines`;
		const hint = contentWidth < 58 ? "Esc back · ↑↓/Pg scroll" : "Esc back · ↑↓/PgUp/PgDn scroll · Home/End";
		return [surface(accent), ...body.map(surface), surface(this.theme.fg("dim", `${position} · ${hint}`))];
	}
}

export type IdeaForgeCustomUI = Pick<ExtensionCommandContext["ui"], "custom">;
export async function showIdeaForgeReader(ui: IdeaForgeCustomUI, title: string, content: string): Promise<void> {
	await ui.custom<void>((tui, theme, _keys, done) => new IdeaForgeReader(tui, theme, title, content, done), {
		overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
	});
}

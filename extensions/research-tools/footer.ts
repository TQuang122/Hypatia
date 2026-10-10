import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { WARNING_STATUS_KEY } from "./warnings.js";

type Segment = { text: string; color: ThemeColor };
type Totals = {
	input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
	seen: boolean; hasInput: boolean; hasOutput: boolean; missingInput: boolean; missingOutput: boolean; missingCost: boolean;
};

function clean(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function fit(value: string, width: number): string {
	return width > 0 ? truncateToWidth(value, width, width > 1 ? "…" : "") : "";
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatCount(value: number): string {
	if (value < 1_000) return `${Math.round(value)}`;
	const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
	return `${Number((value / divisor).toFixed(1))}${divisor === 1_000 ? "k" : "M"}`;
}

function collectUsage(ctx: ExtensionContext): Totals {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, seen: false, hasInput: false, hasOutput: false, missingInput: false, missingOutput: false, missingCost: false };
	// Match Pi's session-wide accounting, including usage outside the active branch.
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
			: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage : undefined;
		if (!usage) continue;
		totals.seen = true;
		const input = number(usage.input), output = number(usage.output), cost = number(usage.cost?.total);
		totals.hasInput ||= input !== undefined;
		totals.hasOutput ||= output !== undefined;
		totals.missingInput ||= input === undefined;
		totals.missingOutput ||= output === undefined;
		totals.missingCost ||= cost === undefined;
		totals.input += input ?? 0;
		totals.output += output ?? 0;
		totals.cacheRead += number(usage.cacheRead) ?? 0;
		totals.cacheWrite += number(usage.cacheWrite) ?? 0;
		totals.cost += cost ?? 0;
	}
	return totals;
}

function usingSubscription(ctx: ExtensionContext): boolean {
	if (!ctx.model) return false;
	if (ctx.model.provider === "kimi-coding") return true;
	return ctx.modelRegistry.isUsingOAuth(ctx.model)
		&& ctx.modelRegistry.getProvider(ctx.model.provider)?.auth?.oauth?.isSubscription === true;
}

function joinSegments(parts: Segment[], theme: Theme): string {
	return parts.map((part) => theme.fg(part.color, part.text)).join(theme.fg("dim", " · "));
}

function metricsLine(ctx: ExtensionContext, totals: Totals, theme: Theme, width: number): string {
	const usage = ctx.getContextUsage();
	const percent = number(usage?.percent);
	const contextText = percent === undefined ? "ctx --" : `ctx ${Math.round(percent)}%`;
	const context: Segment = { text: contextText, color: percent !== undefined && percent > 90 ? "error" : percent !== undefined && percent > 70 ? "warning" : "dim" };
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	const tokenText = totals.seen
		? `${totals.hasInput || promptTokens > 0 ? `↑${formatCount(promptTokens)}${totals.missingInput ? "+" : ""}` : "↑--"} ${totals.hasOutput ? `↓${formatCount(totals.output)}${totals.missingOutput ? "+" : ""}` : "↓--"}` : "usage --";
	const subscription = usingSubscription(ctx);
	const costValue = totals.cost < .001 ? "$<0.001" : `$${totals.cost.toFixed(3)}`;
	const costText = totals.cost > 0 ? `${costValue}${totals.missingCost ? "+" : ""}${subscription ? " (sub)" : ""}` : subscription ? "sub" : "cost --";
	const cache = [totals.cacheRead ? `R${formatCount(totals.cacheRead)}` : "", totals.cacheWrite ? `W${formatCount(totals.cacheWrite)}` : ""].filter(Boolean).join(" ");
	const parts: Array<Segment & { kind: string }> = [
		...(ctx.model?.reasoning ? [{ kind: "thinking", text: clean(ctx.thinkingLevel ?? "auto"), color: "dim" as const }] : []),
		{ ...context, kind: "context" },
		{ kind: "tokens", text: tokenText, color: "dim" },
		...(cache ? [{ kind: "cache", text: cache, color: "dim" as const }] : []),
		{ kind: "cost", text: costText, color: "dim" },
	];
	const model = ctx.model ? clean(width >= 100 ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id) : "no model";
	// Free space for the model while retaining context; omit lower-priority detail first.
	for (const kind of ["cache", "thinking", "tokens", "cost"]) {
		if (visibleWidth(joinSegments(parts, theme)) + 11 <= width) break;
		const index = parts.findIndex((part) => part.kind === kind);
		if (index >= 0) parts.splice(index, 1);
	}
	const tail = joinSegments(parts, theme);
	const modelWidth = Math.max(0, width - visibleWidth(tail) - 3);
	if (modelWidth === 0) return fit(tail, width);
	return fit(`${theme.fg("accent", fit(model, modelWidth))}${theme.fg("dim", " · ")}${tail}`, width);
}

function severity(text: string): number {
	if (/^(?:Failed|Tool failed|Error)(?:\b|:)/i.test(text)) return 0;
	if (/^(?:Interrupted|Waiting for input)(?:\b|:)/i.test(text)) return 1;
	return 2;
}

function activityLine(data: ReadonlyFooterDataProvider, theme: Theme, width: number): string {
	const statuses = [...data.getExtensionStatuses()].map(([key, text]) => ({ key, text: clean(text) })).filter((status) => status.text);
	statuses.sort((a, b) => severity(a.text) - severity(b.text) || (a.key === "hypatia-activity" ? -1 : b.key === "hypatia-activity" ? 1 : a.key.localeCompare(b.key)));
	const warning = statuses.find((status) => status.key === WARNING_STATUS_KEY);
	const primary = statuses.filter((status) => status.key !== WARNING_STATUS_KEY);
	const text = primary.length ? primary.map((status) => status.text).join(" | ") : "/deepresearch · /lit · /review";
	const color: ThemeColor = primary.length && severity(primary[0]!.text) === 0 ? "error"
		: primary.length && severity(primary[0]!.text) === 1 ? "warning" : "dim";
	const first = primary[0]?.text.split(" | ")[0] ?? text;
	const clock = first.match(/ · (\d+s)$/)?.[1];
	const compactText = clock && width > visibleWidth(clock) + 5
		? `${fit(first.slice(0, -(clock.length + 3)), width - visibleWidth(clock) - 3)} · ${clock}`
		: fit(text, width);
	if (!warning) return theme.fg(primary.length ? color : "dim", compactText);
	const warningText = theme.fg("warning", warning.text);
	const warningWidth = visibleWidth(warning.text);
	const gap = "  ";
	if (warningWidth + visibleWidth(gap) < width) {
		const leftWidth = width - warningWidth - visibleWidth(gap);
		return `${fit(theme.fg(primary.length ? color : "dim", compactText), leftWidth)}${gap}${warningText}`;
	}
	const count = warning.text.match(/\d+/)?.[0] ?? "!";
	const compactWarning = theme.fg("warning", `⚠ ${count} · F2`);
	if ((!primary.length || severity(primary[0]!.text) > 1) && visibleWidth(compactWarning) <= width) return fit(compactWarning, width);
	return fit(theme.fg(primary.length ? color : "warning", primary.length ? compactText : warning.text), width);
}

export function installHypatiaFooter(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	ctx.ui.setFooter((_tui, initialTheme, data) => {
		let cachedKey: string | undefined;
		let totals: Totals;
		return {
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [];
				// Every appended Pi entry advances the leaf. Avoid rescanning on every token/frame.
				const key = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}`;
				if (key !== cachedKey) {
					totals = collectUsage(ctx);
					cachedKey = key;
				}
				const theme = ctx.ui.theme ?? initialTheme;
				return [metricsLine(ctx, totals, theme, width), activityLine(data, theme, width)];
			},
		};
	});
}

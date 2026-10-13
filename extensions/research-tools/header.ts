import { basename, dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	isViewportTUI,
	ScrollView,
	Text,
	truncateToWidth,
	VStack,
	type Component,
	type ScrollViewScrollbar,
	type ViewportTUI,
} from "@earendil-works/pi-tui";

import { findResumableRuns } from "./resume-nudge.js";
import { HYPATIA_VERSION } from "./shared.js";

function formatProjectName(path: string): string {
	const projectName = singleLine(basename(path) || path);
	if (projectName.toLowerCase() !== "hypatia") return projectName;
	const parentName = singleLine(basename(dirname(path)));
	return `${parentName || "workspace"}/${projectName}`;
}

function singleLine(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, width > 3 ? "…" : "");
}

function formatSessionLabel(value: string): string {
	const label = singleLine(value);
	return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(label) ? `session ${label.slice(0, 8)}` : label;
}

export type PinnedPromptState = { text?: string; stickyTop: boolean };

function renderPinnedPrompt(text: string | undefined, theme: Theme, width: number, showRule: boolean): string[] {
	if (!text || width <= 0) return [];
	const padding = width >= 8 ? 1 : 0;
	const line = fit(`You › ${singleLine(text)}`, Math.max(0, width - padding * 2));
	const promptRow = new Text(
		`${theme.fg("accent", line.slice(0, 5))}${theme.fg("text", line.slice(5))}`,
		padding,
		0,
		(content) => theme.bg("userMessageBg", content),
	).render(width);
	return showRule ? [...promptRow, theme.fg("borderMuted", "─".repeat(width))] : promptRow;
}

export function installPinnedPromptLayout(
	tui: ViewportTUI,
	prompt: PinnedPromptState,
	theme: Theme,
	scrollbar: ScrollViewScrollbar,
): boolean {
	// shortcut: assumes Pi's current seven-child fullscreen order; recheck this when upgrading Pi.
	if (tui.children.length !== 7) return false;
	const [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer] = tui.children;
	if (!document || !pendingMessages || !status || !widgetsAbove || !editor || !widgetsBelow || !footer) return false;
	const transcript = new ScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar,
		scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
		scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
	});
	const pinned = {
		invalidate() {},
		render(width: number): string[] {
			return renderPinnedPrompt(
				pinnedPromptAtScroll(document, transcript, prompt.text, width),
				theme,
				width,
				tui.terminal.rows >= 28,
			);
		},
	};
	const dock = new VStack([
		{ component: pendingMessages, shrink: 1, minSize: 0 },
		{ component: status, shrink: 1, minSize: 0 },
		{ component: widgetsAbove, shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: widgetsBelow, shrink: 1, minSize: 0 },
		{ component: footer, shrink: 1, minSize: 0 },
	]);
	tui.setLayoutRoot(new VStack([
		{ component: pinned, basis: "auto", shrink: 0, minSize: 0 },
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]));
	return true;
}

type MeasuredChild = { component: Component; height: number };
type MeasuredContainer = Component & {
	children?: Component[];
	mouseLayout?: { width: number; children: MeasuredChild[] };
};

function measuredChildren(component: Component, width: number): MeasuredChild[] | undefined {
	const container = component as MeasuredContainer;
	const layout = container.mouseLayout;
	if (!container.children || layout?.width !== width || layout.children.length !== container.children.length) return undefined;
	return layout.children.every((child, index) => child.component === container.children![index]) ? layout.children : undefined;
}

function pinnedPromptAtScroll(
	document: Component,
	transcript: ScrollView,
	fallback: string | undefined,
	width: number,
): string | undefined {
	const contentWidth = transcript.getContentWidth(width);
	const documentChildren = measuredChildren(document, contentWidth);
	const chat = (document as MeasuredContainer).children?.[2];
	const chatChildren = chat && measuredChildren(chat, contentWidth);
	if (!documentChildren || !chatChildren) return fallback;

	let chatTop = documentChildren.slice(0, 2).reduce((sum, child) => sum + child.height, 0);
	const topRow = transcript.scrollTop;
	let precedingPrompt: string | undefined;
	for (const child of chatChildren) {
		const end = chatTop + child.height;
		const component = child.component as Component & { text?: unknown };
		// shortcut: Pi exposes no public component-to-row map; update this when that API exists.
		if (component.constructor.name === "UserMessageComponent" && typeof component.text === "string" && child.height > 0) {
			if (topRow >= chatTop && topRow < end) return undefined;
			if (end <= topRow) precedingPrompt = component.text;
		}
		chatTop = end;
	}
	return precedingPrompt ?? (transcript.isFollowingEnd ? fallback : undefined);
}

function sessionStatusLine(): string {
	const parts: string[] = [];
	const budget = singleLine(process.env.HYPATIA_TOOL_BUDGET ?? "");
	if (budget) parts.push(`budget ${budget}`);
	if (process.env.HYPATIA_CONTEXT7?.trim() === "1") parts.push("context7");
	return parts.join(" · ");
}

// Mini block-H mark. Single accent color: theme color names vary
// across themes, and Pi crashes on unknown ones.
const MARK = ["███ ███", "███████", "███ ███"];

function paintMark(activeTheme: Pick<Theme, "fg" | "bold">, line: string): string {
	return activeTheme.fg("accent", activeTheme.bold(line));
}

export function registerPinnedPrompt(pi: ExtensionAPI): PinnedPromptState {
	let context: ExtensionContext | undefined;
	let pending: string | undefined;
	const prompt: PinnedPromptState = { stickyTop: false };
	const widgetKey = "hypatia-pinned-prompt";
	const updateWidget = (): void => {
		if (context?.mode !== "tui" || !context.hasUI) return;
		if (!prompt.text) { context.ui.setWidget(widgetKey, undefined); return; }
		context.ui.setWidget(widgetKey, (tui, initialTheme) => ({
			invalidate() {},
			render(width: number): string[] {
				if (tui.mode !== "fullscreen") prompt.stickyTop = false;
				if (prompt.stickyTop && tui.mode === "fullscreen") return [];
				return renderPinnedPrompt(prompt.text, initialTheme, width, (tui.terminal?.rows ?? 28) >= 28);
			},
		}), { placement: "aboveEditor" });
	};
	const clear = (): void => {
		pending = undefined;
		prompt.text = undefined;
		updateWidget();
	};
	pi.on("input", (event) => {
		if (event.source === "interactive" && !event.streamingBehavior) pending = event.text;
	});
	pi.on("before_agent_start", () => {
		if (pending === undefined) return;
		prompt.text = singleLine(pending) || undefined;
		pending = undefined;
		updateWidget();
	});
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		prompt.stickyTop = false;
		clear();
	});
	pi.on("session_shutdown", () => {
		clear();
		prompt.stickyTop = false;
		context = undefined;
	});
	return prompt;
}

export function installHypatiaHeader(
	ctx: ExtensionContext,
	observeTuiMode?: (mode: "regular" | "fullscreen") => void,
	pinnedPrompt?: PinnedPromptState,
	fullscreenScrollbar: ScrollViewScrollbar = "auto",
): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	ctx.ui.setHeader((tui, theme) => {
	observeTuiMode?.(tui.mode);
	if (pinnedPrompt) {
		const viewport = isViewportTUI(tui) && tui.mode === "fullscreen" ? tui : undefined;
		pinnedPrompt.stickyTop = !!viewport && installPinnedPromptLayout(viewport, pinnedPrompt, theme, fullscreenScrollbar);
	}
	const directory = formatProjectName(ctx.cwd);
	const session = formatSessionLabel(ctx.sessionManager.getSessionName()?.trim() || ctx.sessionManager.getSessionId());
	const status = sessionStatusLine();
	const resumable = findResumableRuns(ctx.cwd).map((run) => run.slug);
	const title = `Hypatia ${HYPATIA_VERSION}`;
	const bottom = [session, status, resumable.length > 0 ? `resume: ${resumable.join(", ")}` : ""]
		.map((part) => part.trim())
		.filter(Boolean)
		.join(" · ");
	return ({
		render(width: number): string[] {
			if (width <= 0) return [];
			const maxWidth = width;
			const middle = directory;
			const right = [title, middle, bottom].map((line) => singleLine(line));
			if (tui?.mode === "fullscreen" && tui.terminal.rows < 28) {
				const compact = `${theme.fg("accent", theme.bold("Hypatia"))}${theme.fg("dim", ` ${HYPATIA_VERSION}`)}  ${theme.fg("text", fit(middle, Math.max(1, maxWidth - 20)))}`;
				return [fit(compact, maxWidth), fit(bottom, maxWidth), ""];
			}

			// Narrow screens fall back to stacked text without the mark.
			if (maxWidth < 60) {
				return [...right.map((line) => fit(line, maxWidth)), ""];
			}
			const gap = "  ";
			const rightWidth = maxWidth - MARK[0]!.length - gap.length;
			return [...MARK.map((mark, index) => {
				const text = fit(right[index] ?? "", rightWidth);
				const colored = index === 0
					? `${theme.fg("text", theme.bold("Hypatia"))}${theme.fg("dim", text.slice("Hypatia".length))}`
					: theme.fg(index === 1 ? "text" : "dim", text);
				return `${paintMark(theme, mark)}${gap}${colored}`;
			}), ""];
		},
		invalidate() {},
	});
	});
}

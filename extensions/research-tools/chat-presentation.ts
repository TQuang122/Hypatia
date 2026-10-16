import { stripVTControlCharacters } from "node:util";
import {
	CustomEditor,
	type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type ThemeColor,
	type MarkdownTransformContext, type Theme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { registerChatImageAttachments } from "./chat-image-attachments.js";
import { registerChatWelcome } from "./chat-welcome.js";
import { registerChatTips, type ChatTips } from "./chat-tips.js";

type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

const THINKING_COLORS: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export function thinkingColor(level: ExtensionContext["thinkingLevel"]): ThemeColor {
	return level ? THINKING_COLORS[level] : "borderMuted";
}

function compactCitationLabel(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
		if (host === "arxiv.org") {
			const id = parsed.pathname.match(/^\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/u)?.[1];
			if (id) return `arXiv:${id}`;
		}
		if (host === "openreview.net" && parsed.pathname === "/forum") {
			const id = parsed.searchParams.get("id");
			if (id && /^[\w-]+$/u.test(id)) return `OpenReview:${id}`;
		}
		if (host === "doi.org") {
			const doi = decodeURIComponent(parsed.pathname.slice(1));
			if (/^10\.\d{4,9}\/\S+$/u.test(doi)) return `DOI:${doi}`;
		}
	} catch {
		// Leave malformed or non-citation URLs as authored.
	}
	return undefined;
}

function replaceRawCitationUrls(text: string, hyperlinks: boolean): string {
	const savedLinks: string[] = [];
	const protectedLinks = text.replace(/\[([^\]\n]*)\]\(\s*(<?https?:\/\/[^)\s>]+>?)(?:\s+["'][^)]*["'])?\s*\)/gu, (whole, label: string, destination: string) => {
		const url = destination.replace(/^<|>$/gu, "");
		const shortLabel = compactCitationLabel(url);
		let display = whole;
		if (shortLabel && /^https?:\/\//iu.test(label.trim()) && label.trim().replace(/[.,;!?]+$/u, "") === url) {
			display = hyperlinks ? `[${shortLabel}](<${url}>)` : shortLabel;
		} else if (shortLabel && !hyperlinks) {
			// Pi's plain-terminal link fallback prints the full destination. Keep
			// the authored title and show its compact identifier beside it instead.
			display = `${label} (${shortLabel})`;
		}
		savedLinks.push(display);
		return `\u0000HYPATIA_LINK_${savedLinks.length - 1}\u0000`;
	});
	const compacted = protectedLinks.replace(/<?https?:\/\/[^\s<>`]+>?/giu, (candidate) => {
		const angleWrapped = candidate.startsWith("<") && candidate.endsWith(">");
		let url = angleWrapped ? candidate.slice(1, -1) : candidate;
		while (/[.,;!?]$/u.test(url)) url = url.slice(0, -1);
		while (url.endsWith(")") && (url.match(/\)/gu)?.length ?? 0) > (url.match(/\(/gu)?.length ?? 0)) url = url.slice(0, -1);
		const shortLabel = compactCitationLabel(url);
		if (!shortLabel) return candidate;
		return hyperlinks ? `[${shortLabel}](<${url}>)` : shortLabel;
	});
	return compacted.replace(/\u0000HYPATIA_LINK_(\d+)\u0000/gu, (_placeholder, index: string) => savedLinks[Number(index)] ?? "");
}

function compactHeadingHashes(text: string): string {
	// Pi deliberately displays ###+ as a heading prefix. Render these as h2 so
	// the TUI keeps the heading emphasis and spacing without exposing Markdown.
	return text.replace(/^( {0,3})#{3,6}(?=\s)/u, "$1##");
}

function styleInlineCitationMarkers(line: string, theme: Theme): string {
	if (/^ {0,3}\[[^\]]+\]:\s/u.test(line)) return line;
	const marker = /\[(?:\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*|S\d{1,3})\]/giu;
	return line.replace(marker, (match, offset: number, source: string) => {
		const after = source.slice(offset + match.length);
		if (source[offset - 1] === "[" || after.startsWith("]") || /^\s*(?:\(|\[)/u.test(after)) return match;
		return theme.fg("accent", match);
	});
}

function transformInlineSafeText(line: string, transform: (text: string) => string): string {
	let result = "";
	let cursor = 0;
	while (cursor < line.length) {
		const opening = line.indexOf("`", cursor);
		if (opening < 0) return result + transform(line.slice(cursor));
		result += transform(line.slice(cursor, opening));
		let delimiterEnd = opening + 1;
		while (line[delimiterEnd] === "`") delimiterEnd++;
		const delimiter = line.slice(opening, delimiterEnd);
		let close = line.indexOf(delimiter, delimiterEnd);
		while (close >= 0 && line[close - 1] === "`") close = line.indexOf(delimiter, close + delimiter.length);
		if (close < 0) return result + line.slice(opening);
		result += line.slice(opening, close + delimiter.length);
		cursor = close + delimiter.length;
	}
	return result;
}

function transformMarkdownLines(markdown: string, transform: (line: string) => string): string {
	const lines = markdown.split("\n");
	let fence: { marker: string; length: number } | undefined;
	return lines.map((line) => {
		const fenceLine = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
		if (fence) {
			if (fenceLine?.[0] === fence.marker && fenceLine.length >= fence.length && new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u").test(line)) fence = undefined;
			return line;
		}
		if (fenceLine) {
			fence = { marker: fenceLine[0] ?? "`", length: fenceLine.length };
			return line;
		}
		return transformInlineSafeText(line, (safeText) => transform(safeText));
	}).join("\n");
}

function formatCitationEntries(markdown: string, theme: Theme): string {
	const lines = markdown.split("\n");
	let fence: { marker: string; length: number } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const first = lines[i] ?? "";
		const fenceLine = /^ {0,3}(`{3,}|~{3,})/u.exec(first)?.[1];
		if (fence) {
			if (fenceLine?.[0] === fence.marker && fenceLine.length >= fence.length && new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u").test(first)) fence = undefined;
			continue;
		}
		if (fenceLine) {
			fence = { marker: fenceLine[0] ?? "`", length: fenceLine.length };
			continue;
		}
		const item = /^ {0,3}(\d{1,3})([.)])\s+(.+)$/u.exec(first);
		if (!item) continue;
		let end = i;
		while (end + 1 < lines.length) {
			const next = lines[end + 1] ?? "";
			if (!next.trim() || /^ {0,3}\d{1,3}[.)]\s/u.test(next) || /^ {0,3}#{1,6}\s/u.test(next)) break;
			if (!/^ {2,}\S/u.test(next)) break;
			end++;
		}
		const entryLines = lines.slice(i, end + 1);
		const entry = entryLines.join("\n");
		if (!/(?:arXiv:\d{4}\.\d{4,5}|OpenReview:[\w-]+|DOI:10\.\d{4,9}\/|arxiv\.org\/|openreview\.net\/forum\?id=|doi\.org\/10\.)/iu.test(entry)) continue;

		// Model-authored bibliography lines often wrap a strong span over several
		// indented lines. Marked/Pi can expose those delimiters in list continuations,
		// so join this citation block into one list paragraph before rendering.
		let body = entryLines.map((line, index) => index === 0 ? item[3] ?? "" : line.trim()).join(" ");
		const metadata = /(\s+[—–]\s+[^—–\n]*\b(?:19|20)\d{2}\b[^\n]*)$/u.exec(body);
		const titleText = metadata?.[1] ? body.slice(0, -metadata[1].length) : body;
		const hasAuthoredStrong = /(?:\*\*|__)/u.test(titleText);
		if (!hasAuthoredStrong) body = `**${titleText}**${metadata?.[1] ? theme.fg("muted", metadata[1]) : ""}`;
		else if (metadata?.[1]) body = `${titleText}${theme.fg("muted", metadata[1])}`;
		const itemPrefix = first.slice(0, first.indexOf(item[3] ?? ""));
		lines.splice(i, end - i + 1, `${itemPrefix}${body}`);
	}
	return lines.join("\n");
}

function styleVerificationCallouts(markdown: string, theme: Theme): string {
	const lines = markdown.split("\n");
	let inFence = false;
	let marker = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
		if (fence) {
			if (!inFence) { inFence = true; marker = fence[0] ?? "`"; }
			else if (fence[0] === marker) inFence = false;
			continue;
		}
		if (inFence || !/^\s*(?:>\s*)?(?:\*\*)?(?:Lưu ý về tính đầy đủ|Lưu ý xác minh|Mức độ xác minh|Verification(?: note| status)|Completeness note|Coverage note|Caveat)\b/iu.test(line)) continue;
		let end = i;
		while (end + 1 < lines.length && (lines[end + 1] ?? "").trim()) end++;
		for (let calloutLine = i; calloutLine <= end; calloutLine++) {
			const content = (lines[calloutLine] ?? "").replace(/^\s*>?\s*/u, "");
			lines[calloutLine] = calloutLine === i
				? `> ${theme.fg("warning", "⚠")} ${content}`
				: `> ${content}`;
		}
		i = end;
	}
	return lines.join("\n");
}

// Pi's Markdown transformer decorates the interactive view only. These visual
// citation transformations never alter messages, model context, storage, or exports.
function formatAssistantMarkdown(markdown: string, context: MarkdownTransformContext, theme: Theme): string {
	const hyperlinks = getCapabilities().hyperlinks;
	let formatted = transformMarkdownLines(markdown, (line) =>
		compactHeadingHashes(styleInlineCitationMarkers(replaceRawCitationUrls(line, hyperlinks), theme)));
	if (!context.isStreaming) formatted = formatCitationEntries(formatted, theme);
	// Keep display math out of blockquotes because Pi renders quote content in italics.
	return styleVerificationCallouts(formatted, theme);
}

function labelTranscript(markdown: string, context: MarkdownTransformContext, theme: Theme): string {
	if (context.messageType === "assistant-thinking" || !markdown.trim() || context.availableWidth < 12) return markdown;
	const label = context.messageType === "user"
		? theme.style("You", { fg: "muted", bold: true })
		: `${theme.fg("accent", "•")} ${theme.style("Hypatia", { fg: "text", bold: true })}`;
	const body = context.messageType === "assistant" ? formatAssistantMarkdown(markdown, context, theme) : markdown;
	return `${label}\n\n${body}`;
}

/** Decorate stock Pi editor rows without moving the cursor or mouse hit areas. */
class HypatiaEditor extends CustomEditor {
	private capturingPaste = false;
	private capturedPaste = "";
	private topBorderUsesPiColor = false;

	constructor(
		tui: TUI, editorTheme: EditorTheme,
		bindings: KeybindingsManager,
		private readonly activeTheme: () => Theme,
		private readonly activeThinkingLevel: () => ExtensionContext["thinkingLevel"],
		private readonly editorChanged: () => void,
		private readonly captureImages: (text: string) => string,
	) {
		super(tui, editorTheme, bindings, { embedWorkingStatus: true });
	}

	override handleInput(data: string): void {
		if (this.capturePastedImagePath(data)) { this.editorChanged(); return; }
		super.handleInput(data);
		this.editorChanged();
	}
	override setText(text: string): void { super.setText(text); this.editorChanged?.(); }
	override insertTextAtCursor(text: string): void { super.insertTextAtCursor(this.captureImages(text)); this.editorChanged(); }

	private capturePastedImagePath(data: string): boolean {
		const start = "\x1b[200~";
		const end = "\x1b[201~";
		if (!this.capturingPaste) {
			const startIndex = data.indexOf(start);
			if (startIndex < 0) return false;
			const before = data.slice(0, startIndex);
			if (before) super.handleInput(before);
			this.capturingPaste = true;
			this.capturedPaste = data.slice(startIndex + start.length);
		} else {
			this.capturedPaste += data;
		}

		const endIndex = this.capturedPaste.indexOf(end);
		if (endIndex < 0) return true;
		const pasted = this.capturedPaste.slice(0, endIndex);
		const remaining = this.capturedPaste.slice(endIndex + end.length);
		this.capturingPaste = false;
		this.capturedPaste = "";
		const transformed = this.captureImages(pasted);
		if (transformed === pasted) {
			super.handleInput(`${start}${pasted}${end}`);
		} else {
			let insert = transformed;
			if (/^[/~.]/u.test(pasted)) {
				const cursor = this.getCursor();
				const line = this.getLines()[cursor.line] ?? "";
				if (cursor.col > 0 && /\w/u.test(line[cursor.col - 1] ?? "")) insert = ` ${insert}`;
			}
			super.handleInput(`${start}${insert}${end}`);
		}
		if (remaining) this.handleInput(remaining);
		return true;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const stock = super.renderTopBorder(width, hiddenLineCount);
		// Preserve Pi's embedded working indicator and hidden-line counts.
		this.topBorderUsesPiColor = width < 12 || /[^─]/u.test(stripVTControlCharacters(stock));
		if (this.topBorderUsesPiColor) return stock;
		const theme = this.activeTheme();
		const label = this.getText().startsWith("!") ? "Shell" : "Message";
		const color = label === "Shell" ? "warning" : thinkingColor(this.activeThinkingLevel());
		const marker = theme.fg(color, "›");
		const heading = `${theme.fg(color, "─ ")}${marker} ${theme.fg("muted", label)} `;
		return heading + theme.fg(color, "─".repeat(Math.max(0, width - visibleWidth(heading))));
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		// Keep Pi's multiline overflow indicator; shortcut help lives in chat.
		if (hiddenLineCount > 0) return super.renderBottomBorder(width, hiddenLineCount);
		const line = "─".repeat(Math.max(0, width));
		if (this.topBorderUsesPiColor) return this.borderColor(line);
		const color = this.getText().startsWith("!") ? "warning" : thinkingColor(this.activeThinkingLevel());
		return this.activeTheme().fg(color, line);
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const lines = super.render(width);
		const theme = this.activeTheme();
		if (this.focused && !this.getText() && !this.isShowingAutocomplete() && !this.disableSubmit && width >= 30) {
			// Replace only trailing blank cells. Slicing ANSI-rendered rows can
			// carry cursor/inverse state into the placeholder or move the IME marker.
			const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
			lines[1] = lines[1].replace(/ +$/u, (blank) => {
				const placeholder = truncateToWidth(" Ask about papers, sources, or findings…", Math.max(0, blank.length - padding - 1), "…");
				return theme.fg("dim", placeholder) + " ".repeat(blank.length - visibleWidth(placeholder));
			});
		}
		// The stock inverse cursor resets all ANSI styles. Restore the text
		// foreground afterward, including when editing in the middle of a line.
		const foreground = theme.fg("text", "").replace(/\x1b\[39m$/u, "");
		for (let i = 1; i < lines.length; i++) {
			const line = theme.fg("text", lines[i].replace(/\x1b\[(?:0|39)m/gu, (reset) => reset + foreground));
			lines[i] = line.replace(/\[Image #\d+\]/gu, (marker) => `${theme.style(marker, { fg: "accent", bold: true })}${foreground}`);
		}
		return lines;
	}
}

export function registerChatPresentation(pi: ExtensionAPI): ChatTips {
	const tips = registerChatTips(pi);
	const welcome = registerChatWelcome(pi, tips);
	const captureImages = registerChatImageAttachments(pi);
	const refreshWidgets = (): void => { welcome.refresh(); tips.refresh(); };
	let current: ExtensionContext | undefined;
	let thinkingLevel: ExtensionContext["thinkingLevel"];
	let activeEditor: HypatiaEditor | undefined;
	let activeTui: TUI | undefined;
	const updateThinkingLevel = (level: ExtensionContext["thinkingLevel"]): void => {
		thinkingLevel = level;
		activeEditor?.invalidate();
		activeTui?.requestRender();
	};
	pi.on("thinking_level_select", (event) => updateThinkingLevel(event.level));
	pi.on("model_select", (_event, ctx) => updateThinkingLevel(ctx.thinkingLevel));
	pi.registerMarkdownTransformer((markdown, context) => {
		if (current?.mode !== "tui" || !current.hasUI) return markdown;
		return labelTranscript(markdown, context, current.ui.theme);
	});
	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		thinkingLevel = ctx.thinkingLevel;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!ctx.ui.getEditorComponent()) {
			ctx.ui.setEditorComponent((tui, theme, bindings) => {
				activeTui = tui;
				activeEditor = new HypatiaEditor(tui, theme, bindings, () => (current ?? ctx).ui.theme, () => thinkingLevel, refreshWidgets, captureImages);
				return activeEditor;
			});
		}
		refreshWidgets();
	});
	return tips;
}

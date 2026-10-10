import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, getImageDimensions, getKeybindings, Image, matchesKey, truncateToWidth, visibleWidth, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { CHAT_LOGO_RASTER_DEFLATE_BASE64, CHAT_LOGO_RASTER_HEIGHT, CHAT_LOGO_RASTER_WIDTH } from "./chat-logo-raster.js";
import type { ChatTips } from "./chat-tips.js";

const WIDGET_KEY = "hypatia-new-session-logo";
const LOGO_PATH = fileURLToPath(new URL("../../assets/hypatia-chat-logo.png", import.meta.url));
const LOGO_BASE64 = readFileSync(LOGO_PATH).toString("base64");
const LOGO_MIME_TYPE = "image/png";
const LOGO_DIMENSIONS = getImageDimensions(LOGO_BASE64, LOGO_MIME_TYPE) ?? { widthPx: 1283, heightPx: 1226 };
const rasterPixels = inflateSync(Buffer.from(CHAT_LOGO_RASTER_DEFLATE_BASE64, "base64"));
const rasterCache = new Map<string, string[]>();
const BRAILLE_DOTS = [
	[0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08],
	[1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80],
] as const;

type Pixel = { r: number; g: number; b: number } | undefined;
type LogoColorToken = "accent" | "border" | "text";

function readRasterPixel(x: number, y: number): Pixel {
	const offset = (y * CHAT_LOGO_RASTER_WIDTH + x) * 4;
	if ((rasterPixels[offset + 3] ?? 0) < 24) return undefined;
	return { r: rasterPixels[offset] ?? 0, g: rasterPixels[offset + 1] ?? 0, b: rasterPixels[offset + 2] ?? 0 };
}

function colorToken(pixel: Pixel): LogoColorToken | undefined {
	if (!pixel) return undefined;
	if (pixel.r > 110 && pixel.r - Math.max(pixel.g, pixel.b) > 32) return "accent";
	const luminance = 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b;
	return luminance < 100 ? "border" : "text";
}

/** Theme-token Braille fallback for TUI hosts without an inline-image protocol. */
function rasterizeLogo(columns: number, rows: number, theme: Theme): string[] {
	const themeKey = (["accent", "border", "text"] as const).map((token) => theme.fg(token, "●")).join("");
	const key = `${columns}:${rows}:${themeKey}`;
	const cached = rasterCache.get(key);
	if (cached) return cached;
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = "";
		for (let column = 0; column < columns; column++) {
			let mask = 0;
			const counts: Record<LogoColorToken, number> = { accent: 0, border: 0, text: 0 };
			for (const [dotColumn, dotRow, bit] of BRAILLE_DOTS) {
				const x = Math.min(CHAT_LOGO_RASTER_WIDTH - 1, Math.floor((column * 2 + dotColumn + 0.5) * CHAT_LOGO_RASTER_WIDTH / (columns * 2)));
				const y = Math.min(CHAT_LOGO_RASTER_HEIGHT - 1, Math.floor((row * 4 + dotRow + 0.5) * CHAT_LOGO_RASTER_HEIGHT / (rows * 4)));
				const token = colorToken(readRasterPixel(x, y));
				if (!token) continue;
				mask |= bit;
				counts[token]++;
			}
			if (mask === 0) line += " ";
			else {
				const token: LogoColorToken = counts.accent > 0 ? "accent" : counts.text >= counts.border ? "text" : "border";
				line += theme.fg(token, String.fromCodePoint(0x2800 + mask));
			}
		}
		lines.push(line);
	}
	rasterCache.set(key, lines);
	return lines;
}

function matchesApplicationShortcut(data: string): boolean {
	const manager = getKeybindings() as unknown as { getEffectiveConfig?: () => Record<string, unknown> };
	const config = manager.getEffectiveConfig?.() ?? {};
	for (const [action, value] of Object.entries(config)) {
		if (!action.startsWith("app.")) continue;
		const keys = Array.isArray(value) ? value : [value];
		if (keys.some((key) => typeof key === "string" && matchesKey(data, key as KeyId))) return true;
	}
	return false;
}

function isShortcutInput(data: string): boolean {
	// Mouse reports are interactions, but not keyboard shortcuts.
	if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) return false;
	if (matchesApplicationShortcut(data)) return true;
	return data.startsWith("\x1b") || [...data].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

class WelcomeLogo implements Component {
	private imageKey = "";
	private image?: Image;
	private imageLines: string[] = [];
	constructor(private readonly tui: TUI, private readonly activeTheme: () => Theme) {}
	invalidate(): void { this.image?.invalidate(); this.imageKey = ""; }

	render(width: number): string[] {
		if (width < 12) return [];
		const fullscreen = this.tui.mode === "fullscreen";
		if (fullscreen && this.tui.terminal.rows < 24) return [];
		const maxHeight = fullscreen ? Math.max(1, Math.min(24, this.tui.terminal.rows - 24)) : 14;
		const cells = getCellDimensions();
		const imageAspect = LOGO_DIMENSIONS.widthPx / LOGO_DIMENSIONS.heightPx;
		const widthForHeight = Math.floor(maxHeight * cells.heightPx * imageAspect / cells.widthPx);
		const maxWidth = fullscreen
			? Math.max(8, Math.min(48, width - 8, widthForHeight))
			: Math.max(8, Math.min(28, width - 4));
		const capabilities = getCapabilities();
		const inlineImageSupported = capabilities.images !== null && !(fullscreen && capabilities.images === "iterm2");
		let art: string[];
		if (inlineImageSupported) {
			const key = `${maxWidth}:${maxHeight}`;
			if (key !== this.imageKey || !this.image) {
				this.image = new Image(LOGO_BASE64, LOGO_MIME_TYPE, {
					fallbackColor: (text) => this.activeTheme().fg("muted", text),
				}, { maxWidthCells: maxWidth, maxHeightCells: maxHeight, filename: "Hypatia" });
				this.imageLines = this.image.render(maxWidth + 2);
				this.imageKey = key;
			}
			art = this.imageLines;
		} else {
			this.image = undefined;
			this.imageKey = "";
			const rasterRows = Math.max(1, Math.min(maxHeight, Math.ceil(maxWidth * cells.widthPx / (imageAspect * cells.heightPx))));
			art = rasterizeLogo(maxWidth, rasterRows, this.activeTheme());
		}
		const left = Math.max(0, Math.floor((width - maxWidth) / 2));
		art = art.map((line) => `${" ".repeat(left)}${line}`);
		const theme = this.activeTheme();
		const captionText = truncateToWidth("Compare papers · trace a claim · summarize a source", Math.max(0, width - 4), "…");
		const caption = theme.fg("muted", captionText);
		const captionPadding = Math.max(0, Math.floor((width - visibleWidth(caption)) / 2));
		const rows = this.tui.mode === "fullscreen" ? this.tui.terminal.rows : 0;
		const spare = Math.max(0, rows - art.length - 2 - 10);
		// Keep half of the free space for the transcript so reload notices and
		// the jump-to-latest affordance retain a real viewport above the logo.
		const bottomPadding = this.tui.mode === "fullscreen" ? Math.floor(spare / 2) : 0;
		return [
			...art,
			"",
			`${" ".repeat(captionPadding)}${caption}`,
			...Array.from({ length: bottomPadding }, () => ""),
		];
	}
}

function hasConversation(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "message"
		&& (entry.message.role === "user" || entry.message.role === "assistant"));
}

export function registerChatWelcome(pi: ExtensionAPI, tips: ChatTips): { refresh(): void } {
	let current: ExtensionContext | undefined;
	let eligible = false;
	let visible = false;
	let welcomeAllowedForSession = false;
	let stopInput: (() => void) | undefined;

	const refresh = (): void => {
		const ctx = current;
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
		if (ctx.ui.getEditorText().trimStart().startsWith("/")) eligible = false;
		const next = eligible && !hasConversation(ctx) && ctx.isIdle() && !ctx.hasPendingMessages();
		if (next === visible) return;
		visible = next;
		tips.setWelcomeVisible(visible);
		if (!visible) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new WelcomeLogo(tui, () => ctx.ui.theme ?? theme), { placement: "aboveEditor" });
	};
	const stopWelcome = (): void => {
		eligible = false;
		refresh();
	};

	pi.on("session_start", (event, ctx) => {
		stopInput?.(); stopInput = undefined;
		current = ctx;
		welcomeAllowedForSession = event.reason === "startup" || event.reason === "new" || event.reason === "reload";
		eligible = welcomeAllowedForSession && !hasConversation(ctx);
		visible = false;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		const observedContext = ctx;
		stopInput = ctx.ui.onTerminalInput((data) => {
			queueMicrotask(() => {
				if (current !== observedContext) return;
				if (isShortcutInput(data) || observedContext.ui.getEditorText().trimStart().startsWith("/")) stopWelcome();
				else refresh();
			});
			return undefined;
		});
		refresh();
	});
	pi.on("input", (event) => {
		if (event.source === "interactive" && event.text.trim()) stopWelcome();
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user") stopWelcome();
	});
	pi.on("turn_start", stopWelcome);
	pi.on("session_tree", () => {
		if (!current) return;
		eligible = welcomeAllowedForSession && !hasConversation(current);
		refresh();
	});
	pi.on("agent_end", () => { tips.setWelcomeVisible(false); });
	pi.on("session_shutdown", () => {
		stopInput?.(); stopInput = undefined;
		if (current?.mode === "tui" && current.hasUI) current.ui.setWidget(WIDGET_KEY, undefined);
		current = undefined; eligible = false; visible = false; welcomeAllowedForSession = false;
		tips.setWelcomeVisible(false);
	});
	return { refresh };
}

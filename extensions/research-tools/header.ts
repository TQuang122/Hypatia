import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { findResumableRuns } from "./resume-nudge.js";
import { HYPATIA_VERSION } from "./shared.js";

function formatProjectName(path: string): string {
	return singleLine(basename(path) || path);
}

function singleLine(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, width > 3 ? "…" : "");
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

export function installHypatiaHeader(
	ctx: ExtensionContext,
	observeTuiMode?: (mode: "regular" | "fullscreen") => void,
): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	ctx.ui.setHeader((tui, theme) => {
	observeTuiMode?.(tui.mode);
	return ({
		render(width: number): string[] {
			if (width <= 0) return [];
			const maxWidth = width;
			const activeTheme = ctx.ui.theme ?? theme;

			const directory = formatProjectName(ctx.cwd);
			const session = singleLine(ctx.sessionManager.getSessionName()?.trim() || ctx.sessionManager.getSessionId());
			const status = sessionStatusLine();
			const resumable = findResumableRuns(ctx.cwd).map((run) => run.slug);

			const title = `Hypatia ${HYPATIA_VERSION}`;
			const middle = directory;
			const bottom = [session, status, resumable.length > 0 ? `resume: ${resumable.join(", ")}` : ""]
				.map((part) => part.trim())
				.filter(Boolean)
				.join(" · ");
			const right = [title, middle, bottom].map((line) => singleLine(line));
			if (tui?.mode === "fullscreen" && tui.terminal.rows < 28) {
				const compact = `${activeTheme.fg("accent", activeTheme.bold("Hypatia"))}${activeTheme.fg("dim", ` ${HYPATIA_VERSION}`)}  ${activeTheme.fg("text", fit(middle, Math.max(1, maxWidth - 20)))}`;
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
					? `${activeTheme.fg("accent", activeTheme.bold("Hypatia"))}${activeTheme.fg("dim", text.slice("Hypatia".length))}`
					: activeTheme.fg(index === 1 ? "text" : "dim", text);
				return `${paintMark(activeTheme, mark)}${gap}${colored}`;
			}), ""];
		},
		invalidate() {},
	});
	});
}

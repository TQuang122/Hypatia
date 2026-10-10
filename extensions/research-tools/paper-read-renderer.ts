import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ThemeColor, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { formatToolDuration } from "./render-utils.js";

type SummaryRow = { color: ThemeColor; text: string };
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanLine(value: unknown, max = 180): string {
	if (typeof value !== "string") return "";
	const plain = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	return truncateToWidth(plain, max, "…");
}

function firstString(values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && cleanLine(value)) return cleanLine(value);
		if (Array.isArray(value)) {
			const nested = firstString(value);
			if (nested) return nested;
		}
	}
	return "";
}

function paperReference(value: unknown): string {
	const raw = cleanLine(value, 160);
	if (!raw) return "paper";
	const arxiv = raw.match(/(?:^|arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/|alphaxiv\.org\/(?:abs|overview)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/iu)?.[1];
	if (arxiv) return `arXiv:${arxiv}`;
	const doi = raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").replace(/^doi:\s*/iu, "");
	if (/^10\.\d{4,9}\/\S+$/iu.test(doi)) return `DOI:${doi}`;
	return truncateToWidth(raw, 64, "…");
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

class PaperReadSummary implements Component {
	constructor(private readonly rows: SummaryRow[], private readonly theme: Theme) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (width <= 0) return [];
	return this.rows.map((row) => truncateToWidth(this.theme.fg(row.color, row.text), width, width > 1 ? "…" : ""));
	}
}

export function createPaperReadRenderers() {
	return {
		// The standard Pi shell applies settings.outputPad around these components.
		renderShell: "default" as const,
		renderCall(args: Record<string, unknown>, theme: Theme): Component {
			const id = paperReference(args.paper);
			const mode = args.fullText === true ? "full text" : "AI report";
			const sections = [
				...(typeof args.section === "string" ? [cleanLine(args.section, 40)] : []),
				...(Array.isArray(args.sections) ? args.sections.map((value) => cleanLine(value, 40)).filter(Boolean) : []),
			].filter(Boolean);
			const sectionLabel = sections.length ? theme.fg("muted", ` · ${sections.join(", ")}`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("Read paper "))}${theme.fg("accent", id)}${theme.fg("dim", ` · ${mode}`)}${sectionLabel}`, 0, 0);
		},
		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext): Component {
			if (options.expanded) {
				return new Text(theme.fg(context.isError ? "error" : "toolOutput", textContent(result)), 0, 0);
			}
			const details = record(result.details);
			const args = record(context.args);
			const fallbackNote = cleanLine(details.fallbackNote);
			const fallbackResult = Array.isArray(details.results) ? record(details.results[0]) : {};
			const content = record(details.content);
			const metadata = record(details.metadata);
			const paperId = paperReference(firstString([
				details.paperId, details.id, args.paper,
				fallbackResult.arxivId, fallbackResult.arxiv_id, fallbackResult.doi, fallbackResult.id,
			]));
			const title = firstString([
				details.title, details.paperTitle, metadata.title, content.title, record(content.paper).title, fallbackResult.title,
			]);
			const rows: SummaryRow[] = [];
			const duration = formatToolDuration(context.durationMs);
			const durationSuffix = duration ? ` · ${duration}` : "";
			if (options.isPartial) {
				rows.push({ color: "accent", text: `Reading · ${paperId}` });
				return new PaperReadSummary(rows, theme);
			}
			if (context.isError) {
				rows.push({ color: "error", text: `Error · ${paperId}${durationSuffix}` });
				const error = cleanLine(textContent(result).split(/\r?\n/u).find((line) => line.trim()));
				if (error) rows.push({ color: "error", text: error });
				return new PaperReadSummary(rows, theme);
			}
			const source = cleanLine(details.source, 48);
			const sourceLabel = source.toLowerCase() === "openalex" ? "OpenAlex"
				: source.toLowerCase() === "arxiv" ? "arXiv"
					: source.toLowerCase() === "semanticscholar" ? "Semantic Scholar" : source;
			const mode = fallbackNote ? `${sourceLabel || "source"} metadata fallback` : args.fullText === true ? "Full text" : "AI report";
			rows.push({ color: fallbackNote ? "warning" : "success", text: `${fallbackNote ? "Fallback" : "Paper read"} · ${paperId} · ${mode}${durationSuffix}` });
			if (title && title.toLowerCase() !== paperId.toLowerCase()) rows.push({ color: "text", text: title });
			const pageCount = typeof details.pageCount === "number" && Number.isFinite(details.pageCount) ? details.pageCount : undefined;
			if (pageCount !== undefined) rows.push({ color: "muted", text: `${pageCount} pages` });
			const requested = Array.isArray(details.requestedSections) ? details.requestedSections.map((value) => cleanLine(value, 40)).filter(Boolean) : [];
			const missing = Array.isArray(details.missingSections) ? details.missingSections.map((value) => cleanLine(value, 40)).filter(Boolean) : [];
			if (requested.length) rows.push({ color: "muted", text: `Sections · ${requested.join(", ")}` });
			if (missing.length) rows.push({ color: "warning", text: `Not found · ${missing.join(", ")}` });
			if (fallbackNote) rows.push({ color: "warning", text: fallbackNote });
			if (details.annotation) rows.push({ color: "muted", text: "Local annotation included" });
			rows.push({ color: "dim", text: fallbackNote ? "Ctrl+O for fallback details" : "Ctrl+O to expand full result" });
			return new PaperReadSummary(rows, theme);
		},
	};
}

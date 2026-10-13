import type { AgentToolResult, Theme, ThemeColor, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { formatToolDuration } from "./render-utils.js";

type SearchKind = "alpha" | "database" | "laya";
type PaperPreview = { title: string; year?: string; identifier?: string };
type SummaryRow = { color: ThemeColor; text: string; preview?: PaperPreview };
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const MAX_PREVIEW_PAPERS = 2;
const MIN_PREVIEW_WIDTH = 64;

const SOURCE_LABELS: Record<string, string> = {
	alphaxiv: "alphaXiv", openalex: "OpenAlex", semanticscholar: "Semantic Scholar",
	arxiv: "arXiv", pubmed: "PubMed", europepmc: "Europe PMC", crossref: "Crossref",
	core: "CORE", doab: "DOAB", biorxiv: "bioRxiv", medrxiv: "medRxiv", oa: "OA recovery",
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function singleLine(value: unknown): string {
	return typeof value === "string"
		? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim() : "";
}

function firstString(values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && singleLine(value)) return singleLine(value);
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
		if (Array.isArray(value)) {
			const nested = firstString(value);
			if (nested) return nested;
		}
	}
	return "";
}

function publicationYear(paper: Record<string, unknown>): string | undefined {
	for (const key of ["year", "publicationYear", "publication_year", "publishedYear", "pubYear"]) {
		const value = paper[key];
		if (typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 2999) return String(value);
		const match = singleLine(value).match(/\b((?:1[6-9]|20|21)\d{2})\b/u)?.[1];
		if (match) return match;
	}
	for (const key of ["publishedAt", "publishedDate", "publicationDate", "published", "date"]) {
		const match = singleLine(paper[key]).match(/\b((?:1[6-9]|20|21)\d{2})\b/u)?.[1];
		if (match) return match;
	}
	return undefined;
}

function doiIdentifier(value: unknown): string | undefined {
	const doi = singleLine(value)
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
		.replace(/^doi:\s*/iu, "");
	return /^10\.\d{4,9}\/\S+$/iu.test(doi) ? `DOI:${doi}` : undefined;
}

function arxivIdentifier(value: unknown): string | undefined {
	const candidate = singleLine(value)
		.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//iu, "")
		.replace(/^arxiv:\s*/iu, "")
		.replace(/\.pdf(?:\?.*)?$/iu, "");
	const id = candidate.match(/(?:\d{4}\.\d{4,5}|[a-z][a-z.-]+\/\d{7})(?:v\d+)?/iu)?.[0];
	return id ? `arXiv:${id}` : undefined;
}

function identifierFromUrl(value: unknown): string | undefined {
	const raw = singleLine(value);
	if (!/^https?:\/\//iu.test(raw)) return undefined;
	try {
		const url = new URL(raw);
		const host = url.hostname.toLowerCase().replace(/^www\./u, "");
		if (host === "doi.org" || host === "dx.doi.org") return doiIdentifier(url.pathname.slice(1));
		if (host === "arxiv.org" || host === "export.arxiv.org") return arxivIdentifier(url.toString());
		if (host === "openalex.org") return `OpenAlex:${url.pathname.split("/").filter(Boolean).at(-1)}`;
		if (host === "pubmed.ncbi.nlm.nih.gov") {
			const pmid = url.pathname.split("/").filter(Boolean)[0];
			return pmid ? `PMID:${pmid}` : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function stableIdentifier(paper: Record<string, unknown>, source: string): string | undefined {
	const arxiv = arxivIdentifier(firstString([paper.arxivId, paper.arxiv_id, paper.arxiv, paper.id_versioned]));
	if (arxiv) return arxiv;
	const doi = doiIdentifier(firstString([paper.doi, paper.DOI, paper.doiUrl, paper.doi_url]));
	if (doi) return doi;
	const pmid = firstString([paper.pmid, paper.PMID, paper.pubmedId, paper.pubmed_id]);
	if (pmid) return `PMID:${pmid}`;
	const pmcid = firstString([paper.pmcid, paper.PMCID, paper.pmcId, paper.pmc_id]);
	if (pmcid) return `PMCID:${pmcid}`;
	const openalex = firstString([paper.openalexId, paper.openalex_id, source === "openalex" ? paper.id : undefined]);
	if (openalex) return `OpenAlex:${openalex.split("/").filter(Boolean).at(-1) ?? openalex}`;
	const semanticScholar = firstString([paper.paperId, paper.paper_id]);
	if (semanticScholar) return `S2:${semanticScholar.slice(0, 10)}`;
	const coreId = firstString([paper.core_id, paper.coreId]);
	if (coreId) return `CORE:${coreId}`;
	return identifierFromUrl(paper.url) ?? identifierFromUrl(paper.id);
}

function paperPreviews(payload: Record<string, unknown>, defaultSource: string): PaperPreview[] {
	const candidates: Array<{ paper: Record<string, unknown>; source: string }> = [];
	const source = singleLine(payload.source) || defaultSource;
	for (const item of Array.isArray(payload.results) ? payload.results : []) candidates.push({ paper: record(item), source });
	for (const key of ["semantic", "keyword", "agentic"]) {
		const group = record(payload[key]);
		const groupSource = singleLine(group.source) || source;
		for (const item of Array.isArray(group.results) ? group.results : []) candidates.push({ paper: record(item), source: groupSource });
	}
	const seen = new Set<string>();
	const previews: PaperPreview[] = [];
	for (const { paper, source: paperSource } of candidates) {
		const title = firstString([paper.title]);
		if (!title) continue;
		const year = publicationYear(paper);
		const identifier = stableIdentifier(paper, paperSource);
		if (!year && !identifier) continue;
		const key = (identifier ?? `${title} ${year ?? ""}`).toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		previews.push({ title, ...(year ? { year } : {}), ...(identifier ? { identifier } : {}) });
		if (previews.length === MAX_PREVIEW_PAPERS) break;
	}
	return previews;
}

function sourceLabel(value: unknown): string {
	const source = singleLine(value);
	return SOURCE_LABELS[source.toLowerCase()] ?? source;
}

function returnedCount(value: Record<string, unknown>): number | undefined {
	if (Array.isArray(value.results)) return value.results.length;
	for (const key of ["returned", "n_records_returned"]) {
		const count = value[key];
		if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count;
	}
	return undefined;
}

function counts(payload: Record<string, unknown>): string | undefined {
	const count = returnedCount(payload);
	if (count !== undefined) return `${count} ${count === 1 ? "result" : "results"}`;
	// alphaXiv's both/all modes contain overlapping groups. Do not invent a unique total.
	const groups = ["semantic", "keyword", "agentic"].flatMap((key) => {
		const count = returnedCount(record(payload[key]));
		return count === undefined ? [] : [`${key} ${count}`];
	});
	return groups.length ? groups.join(" / ") : undefined;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

class SearchSummary implements Component {
	constructor(private rows: SummaryRow[], private theme: Theme) {}
	update(rows: SummaryRow[], theme: Theme): void { this.rows = rows; this.theme = theme; }
	invalidate(): void {}
	render(width: number): string[] {
		if (width <= 0) return [];
		return this.rows.flatMap((row) => {
			if (!row.preview) return [truncateToWidth(this.theme.fg(row.color, row.text), width, width > 1 ? "…" : "")];
			if (width < MIN_PREVIEW_WIDTH) return [];
			const metadata = [row.preview.year, row.preview.identifier].filter(Boolean).join(" · ");
			const suffix = metadata ? ` · ${truncateToWidth(metadata, 32, "…")}` : "";
			const titleWidth = Math.max(12, width - 2 - visibleWidth(suffix));
			const title = truncateToWidth(row.preview.title, titleWidth, "…");
			const line = `${this.theme.fg("accent", "•")} ${this.theme.fg("text", title)}${this.theme.fg("dim", suffix)}`;
			return [truncateToWidth(line, width, width > 1 ? "…" : "")];
		});
	}
}

function summary(rows: SummaryRow[], theme: Theme, context: ToolRenderContext): Component {
	if (context.lastComponent instanceof SearchSummary) {
		context.lastComponent.update(rows, theme);
		return context.lastComponent;
	}
	return new SearchSummary(rows, theme);
}

export function createPaperSearchRenderers(kind: SearchKind) {
	return {
		// The standard Pi shell applies settings.outputPad around these components.
		renderShell: "default" as const,
		renderCall(args: Record<string, unknown>, theme: Theme, context: ToolRenderContext): Component {
			const source = sourceLabel(kind === "alpha" ? "alphaxiv" : args.source) || "database";
			const query = singleLine(args.query);
			const title = kind === "laya" ? "Laya advisory" : "Search";
			return summary([{ color: "toolTitle", text: `${title} · ${source}${query ? ` · ${query}` : ""}` }], theme, context);
		},
		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext): Component {
			if (options.expanded) {
				// Render the original text; content/details sent to the model are untouched.
				const text = theme.fg(context.isError ? "error" : "toolOutput", resultText(result));
				if (context.lastComponent instanceof Text) {
					context.lastComponent.setText(text);
					return context.lastComponent;
				}
				return new Text(text, 0, 0);
			}
			const payload = record(result.details);
			const fallback = singleLine(payload.fallbackNote);
			const note = singleLine(payload.note);
			const layaStatus = record(payload.layaStatus);
			const layaMessage = singleLine(layaStatus.message);
			const requested = sourceLabel(kind === "alpha" ? "alphaxiv" : record(context.args).source);
			const delivered = sourceLabel(payload.source) || (kind === "alpha" && !fallback && !context.isError ? "alphaXiv" : "");
			const source = delivered || (requested ? `${requested} (requested)` : "source unavailable");
			const count = counts(payload);
			const duration = formatToolDuration(context.durationMs);
			const durationSuffix = duration ? ` · ${duration}` : "";
			const previews = context.isError ? [] : paperPreviews(payload, kind === "alpha" ? "alphaxiv" : "");
			const rows: SummaryRow[] = [];
			if (context.isError) {
				rows.push({ color: "error", text: `Error · ${source}${durationSuffix}` });
				const error = singleLine(resultText(result).split(/\r?\n/).find((line) => line.trim()));
				if (error) rows.push({ color: "error", text: error });
			} else {
				const state = options.isPartial ? "Searching" : fallback ? "Fallback" : note ? "Note" : "Complete";
				const color: ThemeColor = options.isPartial || fallback || note ? "warning" : "success";
				rows.push({ color, text: `${state} · ${source} · ${count ?? (options.isPartial ? "awaiting results" : "results available")}${options.isPartial && count ? " so far" : ""}${durationSuffix}` });
				if (fallback || note) rows.push({ color: "warning", text: fallback || note });
				if (layaMessage) rows.push({ color: layaStatus.state === "advisory" || layaStatus.state === "reranked" ? "dim" : "warning", text: layaMessage });
				for (const preview of previews) rows.push({ color: "text", text: "", preview });
				if (previews.length) rows.push({ color: "dim", text: "Ctrl+O for full result details" });
			}
			return summary(rows, theme, context);
		},
	};
}

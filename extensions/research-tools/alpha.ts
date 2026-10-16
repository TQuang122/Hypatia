import {
	askPaper,
	annotatePaper,
	clearPaperAnnotation,
	disconnect,
	isLoggedIn,
	listPaperAnnotations,
	normalizePaperId,
	readAnnotation,
	readPaperCode,
	searchPapers,
} from "@companion-ai/alpha-hub/lib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	alphaXivPaperUrl,
	alphaXivSearchPayload,
	discoverPublicAlphaXiv,
	findPublicAlphaXivImplementations,
	readPublicAlphaXivPaper,
	searchPublicAlphaXivFast,
} from "../../src/alpha-public.js";
import type { AlphaXivDiscoveryOptions, AlphaXivSearchMode, AlphaXivSearchPriority } from "../../src/alpha-public.js";
import { extractPaperSections } from "./alpha-sections.js";
import { searchArxiv } from "./science-database-arxiv.js";
import { searchOpenAlex } from "./science-database-openalex.js";
import { createPaperReadRenderers } from "./paper-read-renderer.js";
import { createPaperSearchRenderers } from "./paper-search-renderer.js";

function formatText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

async function searchPublicAlphaXiv(
	query: string,
	mode: AlphaXivSearchMode,
	options: AlphaXivDiscoveryOptions = {},
) {
	if (mode === "title") {
		const hits = await searchPublicAlphaXivFast(query);
		return alphaXivSearchPayload(query, mode, hits, undefined, options.limit);
	}
	if (mode === "both") {
		const [semantic, keyword] = await Promise.all([
			discoverPublicAlphaXiv(query, "embedding", options),
			discoverPublicAlphaXiv(query, "keyword", options),
		]);
		return alphaXivSearchPayload(query, mode, semantic, keyword, options.limit);
	}
	const hits = await discoverPublicAlphaXiv(query, mode === "keyword" ? "keyword" : "embedding", options);
	return alphaXivSearchPayload(query, mode, hits, undefined, options.limit);
}

function paperTitle(content: string): string | undefined {
	return content.match(/^#\s+(.+)\s*$/mu)?.[1]?.trim();
}

// alphaXiv's API has changed without notice before; when a call fails, point
// the model at the other paper sources instead of leaving it on a broken tool.
const ARXIV_ID = /(?:^|arxiv\.org\/(?:abs|pdf)\/|alphaxiv\.org\/(?:abs|overview)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;

// When alphaXiv does not answer (expired login, outage), answer from another
// paper source and say so first, instead of failing the research step.
async function withPaperFallback<T>(
	run: () => Promise<T>,
	fallback?: { source: string; run: () => Promise<Record<string, unknown>> },
): Promise<T | Record<string, unknown>> {
	try {
		return await run();
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).replace("`alpha login`", "`hypatia alpha login`");
		if (fallback) {
			try {
				return { fallbackNote: `alphaXiv did not answer (${message}); these results are from ${fallback.source}.`, ...(await fallback.run()) };
			} catch {}
		}
		throw new Error(
			`${message}\nalphaXiv did not answer this call. Use hypatia_science_database_search (source "arxiv" or "semanticscholar") or fetch_content on https://arxiv.org/abs/<id> instead.`,
		);
	}
}

// Pi converts Type.Array inputs before validating them, which would turn null into ["null"].
// Preserve the JSON Schema array contract without the Type.Array conversion marker.
const paperSectionsSchema = Type.Unsafe<string[]>({
	type: "array",
	items: Type.String({
		description:
			"Multiple sections to extract from content. Supported values: abstract, introduction, methodology, experiments, results, discussion, limitations, conclusion.",
	}),
});

export function registerAlphaTools(pi: ExtensionAPI, signedIn = isLoggedIn()): void {
	// The alphaXiv MCP client keeps a connection open; close it so print and
	// JSON runs can exit once the session ends.
	pi.on("session_shutdown", async () => {
		await disconnect();
	});
	// Search and paper reading use AlphaXiv's public endpoints. Agentic retrieval,
	// PDF Q&A, and repository reading still use account-backed alpha-hub tools.
	const registerAccountTool: ExtensionAPI["registerTool"] = signedIn ? (tool) => pi.registerTool(tool) : () => {};

	pi.registerTool({
		name: "alpha_search",
		label: "Alpha Search",
		...createPaperSearchRenderers("alpha"),
		description:
			"Search papers through AlphaXiv's public endpoints without login. Modes: semantic (default), keyword, both, or title (fast title lookup). Discovery modes accept publication-date filters, ranking, and an output limit; title mode accepts an output limit. Agentic and all modes use account-backed retrieval and require `hypatia alpha login`.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			mode: Type.Optional(
				Type.Union([
					Type.Literal("semantic"),
					Type.Literal("keyword"),
					Type.Literal("both"),
					Type.Literal("title"),
					Type.Literal("agentic"),
					Type.Literal("all"),
				], { description: "Search mode: semantic, keyword, both, title, agentic, or all." }),
			),
			publishedAfter: Type.Optional(Type.String({ description: "Include papers first published on or after YYYY-MM-DD." })),
			publishedBefore: Type.Optional(Type.String({ description: "Include papers first published on or before YYYY-MM-DD." })),
			prioritize: Type.Optional(Type.Union([
				Type.Literal("historical"),
				Type.Literal("default"),
				Type.Literal("recency"),
				Type.Literal("popular"),
			], { description: "Ranking policy after topical relevance: historical, default, recency, or popular." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum results per result group (default 15; maximum 200)." })),
		}),
		async execute(_toolCallId, params) {
			const mode = params.mode?.trim().toLowerCase() || "semantic";
			if (!["semantic", "keyword", "both", "title", "agentic", "all"].includes(mode)) {
				throw new Error("Choose semantic, keyword, both, title, agentic, or all search mode.");
			}
			if (mode === "title" && (params.publishedAfter || params.publishedBefore || params.prioritize)) {
				throw new Error("Date filters and ranking policies apply to semantic/keyword discovery, not fast title search.");
			}
			if ((mode === "agentic" || mode === "all") && (params.publishedAfter || params.publishedBefore || params.prioritize || params.limit !== undefined)) {
				throw new Error("Date filters, ranking, and limits are available on public search modes only.");
			}
			const searchOptions: AlphaXivDiscoveryOptions = {
				...(params.publishedAfter ? { publishedAfter: params.publishedAfter } : {}),
				...(params.publishedBefore ? { publishedBefore: params.publishedBefore } : {}),
				...(params.prioritize ? { prioritize: params.prioritize as AlphaXivSearchPriority } : {}),
				...(params.limit !== undefined ? { limit: params.limit } : {}),
			};
			const result = mode === "agentic" || mode === "all"
				? await withPaperFallback(() => {
						if (!signedIn) throw new Error("This search mode requires an AlphaXiv account. Run `hypatia alpha login`; semantic and keyword search are available without login.");
						return searchPapers(params.query, mode);
					}, {
						source: "OpenAlex semantic search",
						run: () => searchOpenAlex({ source: "openalex", query: `semantic: ${params.query}`, limit: 10 }),
					})
				: await withPaperFallback(() => {
						return searchPublicAlphaXiv(params.query, mode as AlphaXivSearchMode, searchOptions);
					}, {
						source: mode === "title" ? "OpenAlex paper search" : `OpenAlex ${mode === "keyword" ? "keyword" : "semantic"} search`,
						run: () => searchOpenAlex({
							source: "openalex",
							query: mode === "title" ? params.query : `${mode === "keyword" ? "keyword" : "semantic"}: ${params.query}`,
							limit: 10,
						}),
					});
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "alpha_find_implementations",
		label: "Find Paper Implementations",
		description:
			"Find public GitHub repositories that AlphaXiv links to an arXiv paper. Returns repository URLs, stars, and whether AlphaXiv marks a repository as author-provided; it does not read repository files. No login required.",
		parameters: Type.Object({
			paper: Type.String({ description: "arXiv ID, arXiv URL, or AlphaXiv URL." }),
		}),
		async execute(_toolCallId, params) {
			const result = await findPublicAlphaXivImplementations(params.paper);
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "alpha_get_paper",
		label: "Alpha Get Paper",
		...createPaperReadRenderers(),
		description:
			"Fetch a paper's AI-generated report (or raw full text) plus any local annotation. Optional section filters return only requested sections when detectable.",
		parameters: Type.Object({
			paper: Type.String({ description: "arXiv ID, arXiv URL, or alphaXiv URL." }),
			fullText: Type.Optional(Type.Boolean({ description: "Return raw full text instead of AI report." })),
			section: Type.Optional(
				Type.String({
					description:
						"Single section to extract from content: abstract, introduction, methodology, experiments, results, discussion, limitations, or conclusion.",
				}),
			),
			sections: Type.Optional(paperSectionsSchema),
		}),
		async execute(_toolCallId, params) {
			const arxivId = ARXIV_ID.exec(params.paper.trim())?.[1];
			const result = await withPaperFallback(async () => {
				const paper = await readPublicAlphaXivPaper(params.paper, params.fullText === true);
				const paperId = normalizePaperId(paper.paperId);
				return {
					paperId,
					url: alphaXivPaperUrl(params.paper),
					alphaXivUrl: `https://www.alphaxiv.org/overview/${paperId.split("/").map(encodeURIComponent).join("/")}`,
					title: paperTitle(paper.content),
					content: paper.content,
					annotation: readAnnotation(paperId),
					source: "alphaxiv",
				};
			}, arxivId ? {
				source: "arXiv metadata and abstract (no full text or sections)",
				run: () => searchArxiv({ query: arxivId }),
			} : undefined);
			if ("fallbackNote" in result) {
				return { content: [{ type: "text", text: formatText(result) }], details: result };
			}
			const extracted = extractPaperSections(result.content, params.section, params.sections);
			const filteredResult = extracted.requested.length
				? {
						...result,
						content: Object.keys(extracted.selected).length > 0 ? extracted.selected : result.content,
						requestedSections: extracted.requested,
						missingSections: extracted.missing,
					}
				: result;
			return { content: [{ type: "text", text: formatText(filteredResult) }], details: filteredResult };
		},
	});

	registerAccountTool({
		name: "alpha_ask_paper",
		label: "Alpha Ask Paper",
		description: "Ask a targeted question about an arXiv or alphaXiv paper. Uses AI to analyze the PDF and answer. DOI-only papers are not supported; read those with fetch_content on the open-access PDF or Europe PMC full text.",
		parameters: Type.Object({
			paper: Type.String({ description: "arXiv ID, arXiv URL, or alphaXiv URL." }),
			question: Type.String({ description: "Question about the paper." }),
		}),
		async execute(_toolCallId, params) {
			const result = await withPaperFallback(() => askPaper(params.paper, params.question));
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "alpha_annotate_paper",
		label: "Alpha Annotate Paper",
		description: "Write or clear a persistent local annotation for a paper.",
		parameters: Type.Object({
			paper: Type.String({ description: "Paper ID (arXiv ID or URL)." }),
			note: Type.Optional(Type.String({ description: "Annotation text. Omit when clear=true." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the existing annotation." })),
		}),
		async execute(_toolCallId, params) {
			const result = params.clear
				? await clearPaperAnnotation(params.paper)
				: params.note
					? await annotatePaper(params.paper, params.note)
					: (() => { throw new Error("Provide either note or clear=true."); })();
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "alpha_list_annotations",
		label: "Alpha List Annotations",
		description: "List all persistent local paper annotations.",
		parameters: Type.Object({}),
		async execute() {
			const result = await listPaperAnnotations();
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});

	registerAccountTool({
		name: "alpha_read_code",
		label: "Alpha Read Code",
		description: "Read files from a paper's GitHub repository. Use '/' for repo overview.",
		parameters: Type.Object({
			githubUrl: Type.String({ description: "GitHub repository URL." }),
			path: Type.Optional(Type.String({ description: "File or directory path. Default: '/'" })),
		}),
		async execute(_toolCallId, params) {
			const result = await readPaperCode(params.githubUrl, params.path?.trim() || "/");
			return { content: [{ type: "text", text: formatText(result) }], details: result };
		},
	});
}

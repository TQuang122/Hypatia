export type AlphaXivSearchStrategy = "keyword" | "embedding";
export type AlphaXivSearchPriority = "historical" | "default" | "recency" | "popular";
export type AlphaXivDiscoveryOptions = {
	publishedAfter?: string;
	publishedBefore?: string;
	prioritize?: AlphaXivSearchPriority;
	limit?: number;
};
export type AlphaXivSearchMode = "semantic" | "keyword" | "both" | "title";
export type AlphaXivSearchHit = {
	paperId: string;
	title: string;
	abstract: string;
	snippet?: string;
	publicationDate?: string;
	votes?: number;
	snippets: Array<{ pageNumber?: number; snippet: string }>;
};
export type AlphaXivSearchPayload = {
	query: string;
	mode: AlphaXivSearchMode;
	source: "alphaxiv";
	results?: Array<Record<string, unknown>>;
	semantic?: { source: "alphaxiv"; results: Array<Record<string, unknown>> };
	keyword?: { source: "alphaxiv"; results: Array<Record<string, unknown>> };
};

type PublicRequestOptions = {
	fetchImpl?: typeof fetch;
	apiBaseUrl?: string;
	webBaseUrl?: string;
};

const DEFAULT_API_URL = "https://api.alphaxiv.org";
const DEFAULT_WEB_URL = "https://www.alphaxiv.org";
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_SEARCH_RESULTS = 15;
const MAX_SEARCH_RESULT_LIMIT = 200;
const SEARCH_PRIORITIES = new Set<AlphaXivSearchPriority>(["historical", "default", "recency", "popular"]);

function baseUrl(configured: string | undefined, fallback: string): string {
	return (configured?.trim() || fallback).replace(/\/+$/u, "");
}

function retryAfterMs(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function publicGet(url: URL, options: PublicRequestOptions): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? fetch;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				headers: { accept: "application/json, text/markdown", "user-agent": "hypatia-cli" },
				signal: AbortSignal.timeout(20_000),
			});
		} catch {
			throw new Error("Could not reach AlphaXiv's public API.");
		}
		if (response.status !== 429) return response;

		await response.body?.cancel().catch(() => {});
		const wait = retryAfterMs(response.headers.get("retry-after")) ?? attempt * 1_000;
		if (attempt === MAX_RETRIES || wait > MAX_RETRY_AFTER_MS) {
			throw new Error("AlphaXiv's public API is rate-limiting requests. Try again later.");
		}
		await new Promise((resolve) => setTimeout(resolve, wait));
	}
	throw new Error("AlphaXiv's public API is rate-limiting requests. Try again later.");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function resultLimit(limit: number | undefined): number {
	const resolved = limit ?? MAX_SEARCH_RESULTS;
	if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_SEARCH_RESULT_LIMIT) {
		throw new Error(`Search limit must be an integer from 1 to ${MAX_SEARCH_RESULT_LIMIT}.`);
	}
	return resolved;
}

function validPublicationDate(value: string | undefined, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		throw new Error(`${field} must use YYYY-MM-DD format.`);
	}
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
		throw new Error(`${field} must be a valid calendar date.`);
	}
	return value;
}

function normalizeDiscoveryOptions(options: AlphaXivDiscoveryOptions = {}) {
	const publishedAfter = validPublicationDate(options.publishedAfter, "publishedAfter");
	const publishedBefore = validPublicationDate(options.publishedBefore, "publishedBefore");
	if (publishedAfter && publishedBefore && publishedAfter > publishedBefore) {
		throw new Error("publishedAfter must be on or before publishedBefore.");
	}
	const prioritize = options.prioritize ?? "default";
	if (!SEARCH_PRIORITIES.has(prioritize)) {
		throw new Error("prioritize must be historical, default, recency, or popular.");
	}
	return { publishedAfter, publishedBefore, prioritize, limit: resultLimit(options.limit) };
}

function normalizeHit(value: unknown, index: number): Record<string, unknown> | undefined {
	const hit = record(value);
	if (!hit) return undefined;
	const paperId = text(hit.paperId ?? hit.paper_id ?? hit.id).trim();
	const title = text(hit.title).trim();
	if (!paperId || !title) return undefined;
	const abstract = text(hit.abstract ?? hit.abstract_);
	const publicationDate = text(hit.publicationDate ?? hit.publication_date);
	const votes = typeof hit.votes === "number" && Number.isFinite(hit.votes) ? hit.votes : null;
	const rawSnippets = Array.isArray(hit.snippets) && hit.snippets.length > 0
		? hit.snippets
		: typeof hit.snippet === "string" ? [{ snippet: hit.snippet }] : [];
	const snippets = rawSnippets.flatMap((item) => {
		const snippet = record(item);
		if (!snippet || typeof snippet.snippet !== "string") return [];
		return [{
			...(typeof snippet.pageNumber === "number" ? { pageNumber: snippet.pageNumber } : {}),
			snippet: snippet.snippet,
		}];
	});
	return {
		rank: index + 1,
		title,
		visits: null,
		likes: votes,
		publishedAt: publicationDate || null,
		organizations: null,
		authors: text(hit.authors) || null,
		abstract: abstract || null,
		arxivId: paperId,
		alphaXivUrl: `https://www.alphaxiv.org/overview/${paperId.split("/").map(encodeURIComponent).join("/")}`,
		snippets,
	};
}

export function alphaXivSearchPayload(
	query: string,
	mode: AlphaXivSearchMode,
	semantic: AlphaXivSearchHit[],
	keyword?: AlphaXivSearchHit[],
	limit = MAX_SEARCH_RESULTS,
): AlphaXivSearchPayload {
	const boundedLimit = resultLimit(limit);
	const mapHits = (hits: AlphaXivSearchHit[]) => hits.slice(0, boundedLimit)
		.map((hit, index) => normalizeHit(hit, index))
		.filter((hit): hit is Record<string, unknown> => Boolean(hit));
	if (mode === "both") {
		return {
			query,
			mode,
			source: "alphaxiv",
			semantic: { source: "alphaxiv", results: mapHits(semantic) },
			keyword: { source: "alphaxiv", results: mapHits(keyword ?? []) },
		};
	}
	return { query, mode, source: "alphaxiv", results: mapHits(semantic) };
}

export async function discoverPublicAlphaXiv(
	query: string,
	strategy: AlphaXivSearchStrategy,
	options: PublicRequestOptions & AlphaXivDiscoveryOptions = {},
): Promise<AlphaXivSearchHit[]> {
	const cleaned = query.trim();
	if (!cleaned) throw new Error("Search query must not be empty.");
	const discovery = normalizeDiscoveryOptions(options);
	const apiBase = baseUrl(options.apiBaseUrl ?? process.env.ALPHAXIV_API_URL, DEFAULT_API_URL);
	const url = new URL(`${apiBase}/search/v2/paper/discover/${strategy}`);
	url.searchParams.set("q", cleaned);
	url.searchParams.set("prioritize", discovery.prioritize);
	if (discovery.publishedAfter) url.searchParams.set("publishedAfter", discovery.publishedAfter);
	if (discovery.publishedBefore) url.searchParams.set("publishedBefore", discovery.publishedBefore);
	const response = await publicGet(url, options);
	if (!response.ok) throw new Error(`AlphaXiv public search returned HTTP ${response.status}.`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("AlphaXiv returned an unreadable public search response.");
	}
	if (!Array.isArray(payload)) throw new Error("AlphaXiv returned an unexpected public search response.");
	return payload.flatMap((item): AlphaXivSearchHit[] => {
		const hit = record(item);
		if (!hit) return [];
		const paperId = text(hit.paperId ?? hit.paper_id ?? hit.id).trim();
		const title = text(hit.title).trim();
		if (!paperId || !title) return [];
		return [{
			paperId,
			title,
			abstract: text(hit.abstract ?? hit.abstract_),
			...(text(hit.publicationDate ?? hit.publication_date) ? { publicationDate: text(hit.publicationDate ?? hit.publication_date) } : {}),
			...(typeof hit.votes === "number" && Number.isFinite(hit.votes) ? { votes: hit.votes } : {}),
			snippets: Array.isArray(hit.snippets) ? hit.snippets.flatMap((item) => {
				const snippet = record(item);
				return snippet && typeof snippet.snippet === "string" ? [{
					...(typeof snippet.pageNumber === "number" ? { pageNumber: snippet.pageNumber } : {}),
					snippet: snippet.snippet,
				}] : [];
			}) : [],
		}];
	}).slice(0, discovery.limit);
}

/** Search paper titles through AlphaXiv's fast public lookup endpoint. */
export async function searchPublicAlphaXivFast(
	query: string,
	options: PublicRequestOptions = {},
): Promise<AlphaXivSearchHit[]> {
	const cleaned = query.trim();
	if (!cleaned) throw new Error("Search query must not be empty.");
	const apiBase = baseUrl(options.apiBaseUrl ?? process.env.ALPHAXIV_API_URL, DEFAULT_API_URL);
	const url = new URL(`${apiBase}/search/v2/paper/fast`);
	url.searchParams.set("q", cleaned);
	url.searchParams.set("includePrivate", "false");
	const response = await publicGet(url, options);
	if (!response.ok) throw new Error(`AlphaXiv fast search returned HTTP ${response.status}.`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("AlphaXiv returned an unreadable fast-search response.");
	}
	if (!Array.isArray(payload)) throw new Error("AlphaXiv returned an unexpected fast-search response.");
	return payload.flatMap((item): AlphaXivSearchHit[] => {
		const hit = record(item);
		if (!hit) return [];
		const paperId = text(hit.paperId ?? hit.paper_id ?? hit.id).trim();
		const title = text(hit.title).trim();
		if (!paperId || !title) return [];
		const snippet = text(hit.snippet).trim();
		return [{ paperId, title, abstract: "", ...(snippet ? { snippet } : {}), snippets: [] }];
	});
}

export type AlphaXivImplementation = {
	url: string;
	stars?: number;
	source?: string;
};

export type AlphaXivPaperImplementations = {
	paperId: string;
	title?: string;
	implementations: AlphaXivImplementation[];
};

function isPublicGitHubUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && ["github.com", "www.github.com"].includes(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** Resolve an arXiv paper and list its public GitHub implementations from AlphaXiv. */
export async function findPublicAlphaXivImplementations(
	input: string,
	options: PublicRequestOptions = {},
): Promise<AlphaXivPaperImplementations> {
	const paperId = normalizeAlphaXivPaperId(input).replace(/v\d+$/iu, "");
	const apiBase = baseUrl(options.apiBaseUrl ?? process.env.ALPHAXIV_API_URL, DEFAULT_API_URL);
	const paperResponse = await publicGet(new URL(`${apiBase}/papers/v3/${encodeURIComponent(paperId)}`), options);
	if (!paperResponse.ok) throw new Error(`AlphaXiv could not resolve paper ${paperId} (HTTP ${paperResponse.status}).`);
	let paperPayload: unknown;
	try {
		paperPayload = await paperResponse.json();
	} catch {
		throw new Error("AlphaXiv returned unreadable paper metadata.");
	}
	const paper = record(paperPayload);
	if (!paper) throw new Error("AlphaXiv returned unexpected paper metadata.");
	const canonicalPaperId = text(paper.universalId ?? paper.universal_id).trim() || paperId;
	const title = text(paper.title).trim() || undefined;
	const groupId = text(paper.groupId ?? paper.group_id).trim();
	if (!groupId) return { paperId: canonicalPaperId, ...(title ? { title } : {}), implementations: [] };

	const implementationResponse = await publicGet(new URL(`${apiBase}/papers/v3/${encodeURIComponent(groupId)}/implementations`), options);
	if (!implementationResponse.ok) return { paperId: canonicalPaperId, ...(title ? { title } : {}), implementations: [] };
	let implementationPayload: unknown;
	try {
		implementationPayload = await implementationResponse.json();
	} catch {
		return { paperId: canonicalPaperId, ...(title ? { title } : {}), implementations: [] };
	}
	const resources = record(implementationPayload);
	if (!resources) return { paperId: canonicalPaperId, ...(title ? { title } : {}), implementations: [] };
	const rawResources = [resources.paperResources, resources.paper_resources, resources.alphaXivImplementations, resources.alpha_xiv_implementations]
		.flatMap((value) => Array.isArray(value) ? value : []);
	const byUrl = new Map<string, AlphaXivImplementation>();
	for (const rawResource of rawResources) {
		const resource = record(rawResource);
		if (!resource || text(resource.type ?? resource.kind).toLowerCase() !== "github") continue;
		const url = text(resource.url).trim();
		if (!url || !isPublicGitHubUrl(url)) continue;
		const source = text(resource.source).trim() || undefined;
		const stars = typeof resource.stars === "number" && Number.isFinite(resource.stars) ? resource.stars : undefined;
		const candidate: AlphaXivImplementation = { url, ...(stars !== undefined ? { stars } : {}), ...(source ? { source } : {}) };
		const existing = byUrl.get(url);
		if (!existing || (candidate.source === "author" && existing.source !== "author") || (candidate.source === existing.source && (candidate.stars ?? 0) > (existing.stars ?? 0))) {
			byUrl.set(url, candidate);
		}
	}
	const implementations = [...byUrl.values()].sort((left, right) =>
		Number(right.source === "author") - Number(left.source === "author") || (right.stars ?? 0) - (left.stars ?? 0) || left.url.localeCompare(right.url));
	return { paperId: canonicalPaperId, ...(title ? { title } : {}), implementations };
}

export function normalizeAlphaXivPaperId(input: string): string {
	const value = input.trim();
	let id = value;
	if (/^https?:\/\//iu.test(value)) {
		try {
			const url = new URL(value);
			const host = url.hostname.toLowerCase().replace(/^www\./u, "");
			if (!["arxiv.org", "export.arxiv.org", "alphaxiv.org"].includes(host)) {
				throw new Error("Paper URL must be from arXiv or AlphaXiv.");
			}
			const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
			const route = segments.findIndex((segment) => ["abs", "overview", "pdf"].includes(segment.toLowerCase()));
			if (route < 0) throw new Error("Paper URL must point to an arXiv or AlphaXiv paper.");
			id = segments.slice(route + 1).join("/");
		} catch {
			throw new Error("Paper identifier must be an arXiv/AlphaXiv ID or URL.");
		}
	}
	id = id.trim().replace(/^arxiv:\s*/iu, "").replace(/\s+\[[^\]]+\]\s*$/u, "");
	id = id.split(/[?#]/u, 1)[0]!.replace(/\.(?:pdf|html?|md)$/iu, "").replace(/^\/+|\/+$/gu, "");
	if (!id || id.length > 300 || /[\r\n]/u.test(id) || id.split("/").some((part) => part === "." || part === "..")) {
		throw new Error("Paper identifier is empty or invalid.");
	}
	return id;
}

export function alphaXivPaperUrl(input: string): string {
	const value = input.trim();
	if (/^https?:\/\//iu.test(value)) return value;
	const id = normalizeAlphaXivPaperId(value);
	const arxivId = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/iu.test(id);
	const path = id.split("/").map(encodeURIComponent).join("/");
	return arxivId ? `https://arxiv.org/abs/${path}` : `https://www.alphaxiv.org/abs/${path}`;
}

export type AlphaXivPaperMarkdown = {
	paperId: string;
	content: string;
	kind: "overview" | "abs";
};

export async function readPublicAlphaXivPaper(
	input: string,
	fullText = false,
	options: PublicRequestOptions = {},
): Promise<AlphaXivPaperMarkdown> {
	const paperId = normalizeAlphaXivPaperId(input).replace(/v\d+$/iu, "");
	const webBase = baseUrl(options.webBaseUrl ?? process.env.ALPHAXIV_WEB_URL, DEFAULT_WEB_URL);
	const kinds: Array<AlphaXivPaperMarkdown["kind"]> = fullText ? ["abs"] : ["overview", "abs"];
	for (const kind of kinds) {
		const encodedId = paperId.split("/").map(encodeURIComponent).join("/");
		const response = await publicGet(new URL(`${webBase}/${kind}/${encodedId}.md`), options);
		if (response.status === 404 && !fullText) continue;
		if (response.status === 404) throw new Error("AlphaXiv has not published extracted full text for this paper yet.");
		if (!response.ok) throw new Error(`AlphaXiv public paper request returned HTTP ${response.status}.`);
		const content = await response.text();
		if (!content.trim()) throw new Error("AlphaXiv returned an empty paper document.");
		return { paperId, content, kind };
	}
	throw new Error("AlphaXiv has no report or extracted full text for this paper yet.");
}

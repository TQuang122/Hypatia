import { createRequestPacer } from "./request-pacer.js";

type SearchParams = {
	limit?: number;
	query: string;
};

const CORE_BASE = "https://api.core.ac.uk/v3";
const CORE_DOCS = "https://api.core.ac.uk/docs/v3";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 25_000;
const CORE_ABSTRACT_CHARS = 600;
// CORE only serves full text to keyed requests; anonymous calls get basic
// metadata with fullText set to "Not available for public API users."
const CORE_NO_FULL_TEXT = "Not available for public API users.";

export const CORE_API_KEY_HINT = "Get a free CORE API key at https://core.ac.uk/services/api and set CORE_API_KEY; without a key only basic metadata is returned, no full text.";

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function cleanQuery(query: string): string {
	const clean = query.trim();
	if (!clean) throw new Error("Science database search requires a non-empty query.");
	return clean;
}

function safeLimit(value: number | undefined): number {
	if (!Number.isFinite(value) || value === undefined) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
}

function doiUrl(doi: string | undefined): string | undefined {
	return doi ? `https://doi.org/${doi}` : undefined;
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
	if (!value || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).trimEnd()}…`;
}

function coreApiKey(): string | undefined {
	return process.env.CORE_API_KEY?.trim() || undefined;
}

// CORE v2 documented single requests at 5 per 10 seconds; v3 publishes no new
// number, so pace conservatively. Pi runs parallel tool calls in one process.
const corePacer = createRequestPacer();

function withCorePacing<T>(run: () => Promise<T>): Promise<T> {
	return corePacer(1200, run);
}

function coreRequestFailure(status: number, statusText: string, usingApiKey: boolean): Error {
	const hint = !usingApiKey && [401, 403, 429].includes(status) ? ` ${CORE_API_KEY_HINT}` : "";
	return new Error(`CORE request failed: ${status} ${statusText}.${hint}`);
}

async function fetchJson(url: URL, apiKey: string | undefined): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: {
				accept: "application/json",
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw coreRequestFailure(response.status, response.statusText, Boolean(apiKey));
		}
		return response.json();
	} finally {
		clearTimeout(timeout);
	}
}

function parseCoreQuery(query: string): { fulltextOnly: boolean; text: string } {
	let fulltextOnly = false;
	const textParts: string[] = [];
	for (const part of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
		const match = part.match(/^([a-z_]+)=(.+)$/i);
		if (match?.[1]?.toLowerCase() === "fulltext_only" && /^(true|1|yes)$/i.test(match[2] ?? "")) {
			fulltextOnly = true;
		} else {
			textParts.push(part);
		}
	}
	return { fulltextOnly, text: textParts.join(" ").trim() };
}

function stripDoiPrefix(text: string): string {
	return text.trim().replace(/^doi:\s*/i, "").trim();
}

function coreAuthors(value: unknown): string[] {
	return arrayValue(value)
		.map((author) => stringValue(recordValue(author).name))
		.filter((name): name is string => Boolean(name))
		.slice(0, 8);
}

function hasFullText(record: Record<string, unknown>): boolean {
	const fullText = stringValue(record.fullText);
	if (!fullText || fullText === CORE_NO_FULL_TEXT) return false;
	return stringValue(record.downloadUrl) !== undefined || fullText.length > 0;
}

function parseCoreWork(item: unknown): Record<string, unknown> | undefined {
	const record = recordValue(item);
	const id = numberValue(record.id) ?? stringValue(record.id);
	const title = stringValue(record.title);
	if (id === undefined || !title) return undefined;
	const doi = stringValue(record.doi);
	const downloadUrl = stringValue(record.downloadUrl);
	return {
		core_id: id,
		title,
		authors: coreAuthors(record.authors),
		abstract: truncateText(stringValue(record.abstract), CORE_ABSTRACT_CHARS),
		doi,
		year: numberValue(record.yearPublished),
		publishedDate: stringValue(record.publishedDate),
		publisher: stringValue(record.publisher),
		documentType: stringValue(record.documentType),
		fieldOfStudy: stringValue(record.fieldOfStudy),
		language: stringValue(record.language),
		citationCount: numberValue(record.citationCount),
		arxivId: stringValue(record.arxivId),
		pmid: stringValue(record.pubmedId),
		downloadUrl,
		hasFullText: hasFullText(record),
		url: downloadUrl ?? doiUrl(doi),
		...(doiUrl(doi) ? { doiUrl: doiUrl(doi) } : {}),
	};
}

export async function searchCore(params: SearchParams): Promise<Record<string, unknown>> {
	const parsed = parseCoreQuery(cleanQuery(params.query));
	const text = stripDoiPrefix(parsed.text);
	if (!text) throw new Error("Science database search requires a non-empty query.");
	const limit = safeLimit(params.limit);
	const apiKey = coreApiKey();
	const url = new URL(`${CORE_BASE}/search/works/`);
	url.search = new URLSearchParams({
		q: text,
		limit: String(limit),
	}).toString();
	const payload = recordValue(await withCorePacing(() => fetchJson(url, apiKey)));
	let results = arrayValue(payload.results).flatMap((item) => {
		const row = parseCoreWork(item);
		return row ? [row] : [];
	});
	if (parsed.fulltextOnly) {
		results = results.filter((row) => row.hasFullText === true);
	}
	const credentialStatus = apiKey ? "CORE_API_KEY present" : `CORE_API_KEY missing. ${CORE_API_KEY_HINT}`;
	return {
		schema: "hypatia.scienceDatabaseSearch.v1",
		source: "core",
		query: params.query.trim(),
		...(parsed.fulltextOnly ? { fulltextOnly: true } : {}),
		credentialStatus,
		...(!apiKey ? { note: "Results are metadata-only without CORE_API_KEY; full text is not served to anonymous requests. Set a free key to get download URLs and full text." } : {}),
		totalCount: numberValue(payload.totalHits) ?? results.length,
		returned: results.length,
		results,
		provenance: {
			docs: CORE_DOCS,
			endpoints: [url.toString()],
		},
	};
}

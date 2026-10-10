type SearchParams = {
	limit?: number;
	query: string;
};

const DOAB_BASE = "https://directory.doabooks.org";
const DOAB_REST_BASE = `${DOAB_BASE}/rest`;
const DOAB_DOCS = "https://doabooks.org/en/article/api-search-doab";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 25_000;

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function cleanIsbn(value: string): string {
	return value.replace(/[^0-9Xx]/g, "");
}

// Map the tool's prefix syntax onto DOAB's documented fielded search
// (dc.title, dc.identifier.isbn, dc.identifier.doi, dc.contributor.author);
// anything else stays a full-text query.
function toDoabQuery(query: string): string {
	const clean = query.trim().replace(/^(doab|books?):\s*/i, "").trim();
	const isbn = clean.match(/^isbn:\s*(.+)$/i)?.[1];
	if (isbn) {
		const digits = cleanIsbn(isbn);
		if (!digits) throw new Error(`No ISBN found in "${query}". Use isbn:<digits>, e.g. isbn:9780262035613.`);
		return `dc.identifier.isbn:${digits}`;
	}
	const doi = clean.match(/^doi:\s*(.+)$/i)?.[1]?.trim();
	if (doi) return `dc.identifier.doi:${doi.replace(/^"|"$/g, "")}`;
	const title = clean.match(/^title:\s*(.+)$/i)?.[1]?.trim();
	if (title) return `dc.title:${title}`;
	const author = clean.match(/^author:\s*(.+)$/i)?.[1]?.trim();
	if (author) return `dc.contributor.author:${author}`;
	return clean;
}

async function fetchJson(url: URL): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`DOAB request failed: ${response.status} ${response.statusText}`);
		}
		return response.json();
	} finally {
		clearTimeout(timeout);
	}
}

type DoabMetadata = {
	abstract?: string;
	authors: string[];
	doi?: string;
	isbns: string[];
	language?: string;
	license?: string;
	publicationDate?: string;
	publisher?: string;
	repository?: string;
	subjects: string[];
	title?: string;
	type?: string;
	uri?: string;
};

function extractDoabMetadata(fields: unknown): DoabMetadata {
	const meta: DoabMetadata = { authors: [], isbns: [], subjects: [] };
	for (const field of arrayValue(fields)) {
		const record = recordValue(field);
		const key = stringValue(record.key)?.toLowerCase();
		const value = stringValue(record.value);
		if (!key || !value) continue;
		switch (key) {
			case "dc.title":
				meta.title ??= value;
				break;
			case "dc.contributor.author":
			case "dc.creator":
				meta.authors.push(value);
				break;
			case "dc.identifier.isbn": {
				const digits = cleanIsbn(value);
				if (digits) meta.isbns.push(digits);
				break;
			}
			case "dc.identifier.doi":
			case "oapen.identifier.doi":
				meta.doi ??= value;
				break;
			case "dc.identifier.uri":
				meta.uri ??= value;
				break;
			case "dc.publisher":
			case "publisher.name":
			case "oapen.imprint":
				meta.publisher ??= value;
				break;
			case "dc.date.issued":
			case "dc.date":
				meta.publicationDate ??= value;
				break;
			case "dc.description.abstract":
			case "dc.description":
				meta.abstract ??= value;
				break;
			case "dc.subject":
			case "dc.subject.classification":
				meta.subjects.push(value);
				break;
			case "dc.language":
			case "dc.language.iso":
				meta.language ??= value;
				break;
			case "dc.rights":
			case "dc.rights.uri":
				meta.license ??= value;
				break;
			case "dc.type":
				meta.type ??= value;
				break;
			case "oapen.relation.ispublishedby":
				meta.repository ??= value;
				break;
			default:
				break;
		}
	}
	return meta;
}

// Live shape (verified 2026-09-30): items carry metadata[] plus THUMBNAIL
// and EXPORT bitstreams; the full text itself usually lives on the
// publisher site, so THUMBNAIL/EXPORT bitstreams are never OA candidates.
const DOAB_NON_CONTENT_BUNDLES = new Set(["thumbnail", "export"]);

function isPdfBitstream(bitstream: Record<string, unknown>): boolean {
	const format = stringValue(bitstream.format)?.toLowerCase() ?? "";
	const mime = stringValue(bitstream.mimeType)?.toLowerCase() ?? "";
	const name = stringValue(bitstream.name)?.toLowerCase() ?? "";
	return format.includes("pdf") || mime.includes("pdf") || name.endsWith(".pdf");
}

function resolveDoabLink(link: string | undefined): string | undefined {
	if (!link) return undefined;
	if (/^https?:\/\//i.test(link)) return link;
	return `${DOAB_BASE}${link.startsWith("/") ? link : `/${link}`}`;
}

function doabOpenAccessUrl(item: Record<string, unknown>, meta: DoabMetadata, handle: string | undefined): string | undefined {
	const content = arrayValue(item.bitstreams)
		.map(recordValue)
		.filter((bitstream) => !DOAB_NON_CONTENT_BUNDLES.has(stringValue(bitstream.bundleName)?.toLowerCase() ?? ""));
	const pdf = content.find(isPdfBitstream);
	const link = resolveDoabLink(stringValue(pdf?.retrieveLink))
		?? resolveDoabLink(stringValue(content[0]?.retrieveLink))
		?? meta.uri;
	if (link) return link;
	return handle ? `${DOAB_BASE}/handle/${handle}` : undefined;
}

function parseDoabItem(item: unknown): Record<string, unknown> | undefined {
	const record = recordValue(item);
	const meta = extractDoabMetadata(record.metadata);
	if (!meta.title) return undefined;
	const uuid = stringValue(record.uuid);
	const handle = stringValue(record.handle);
	const doi = meta.doi;
	const openAccessUrl = doabOpenAccessUrl(record, meta, handle);
	return {
		...(uuid ? { doab_uuid: uuid } : {}),
		title: meta.title,
		authors: meta.authors.slice(0, 8),
		...(meta.isbns.length > 0 ? { isbns: meta.isbns } : {}),
		...(meta.publisher ? { publisher: meta.publisher } : {}),
		...(meta.publicationDate ? { publicationDate: meta.publicationDate } : {}),
		...(meta.type ? { type: meta.type } : {}),
		...(meta.abstract ? { abstract: meta.abstract } : {}),
		...(meta.subjects.length > 0 ? { subjects: meta.subjects } : {}),
		...(meta.language ? { language: meta.language } : {}),
		...(meta.license ? { license: meta.license } : {}),
		...(meta.repository ? { repository: meta.repository } : {}),
		doi,
		openAccessUrl,
		url: openAccessUrl,
		...(doiUrl(doi) ? { doiUrl: doiUrl(doi) } : {}),
	};
}

function doabItems(payload: unknown): Record<string, unknown>[] {
	const record = recordValue(payload);
	const direct = arrayValue(record.items);
	if (direct.length > 0) return direct.map(recordValue);
	if (Array.isArray(payload)) return payload.map(recordValue);
	return [];
}

export async function searchDoab(params: SearchParams): Promise<Record<string, unknown>> {
	const query = cleanQuery(params.query);
	const limit = safeLimit(params.limit);
	const url = new URL(`${DOAB_REST_BASE}/search`);
	url.search = new URLSearchParams({
		query: toDoabQuery(query),
		expand: "metadata,bitstreams",
		limit: String(limit),
	}).toString();
	const payload = await fetchJson(url);
	const results = doabItems(payload)
		.map(parseDoabItem)
		.filter((row): row is Record<string, unknown> => Boolean(row))
		.slice(0, limit);
	return {
		schema: "hypatia.scienceDatabaseSearch.v1",
		source: "doab",
		query,
		totalCount: results.length,
		returned: results.length,
		results,
		provenance: {
			docs: DOAB_DOCS,
			endpoints: [url.toString()],
		},
	};
}

import { createRequestPacer } from "./request-pacer.js";
import { searchCore } from "./science-database-core.js";

type SearchParams = {
	limit?: number;
	query: string;
};

const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
const UNPAYWALL_DOCS = "https://unpaywall.org/products/api";
const EUROPE_PMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const REQUEST_TIMEOUT_MS = 25_000;

export const UNPAYWALL_EMAIL_HINT = "Set UNPAYWALL_EMAIL (or NCBI_EMAIL) to your email address to enable the Unpaywall step; Unpaywall requires a contact email and no placeholder is ever sent.";

// Unpaywall allows 100k calls/day with no published per-second quota; pace
// modestly because Pi runs parallel tool calls in one process.
const unpaywallPacer = createRequestPacer();

function withUnpaywallPacing<T>(run: () => Promise<T>): Promise<T> {
	return unpaywallPacer(500, run);
}

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
	const clean = query.trim().replace(/^(?:oa|open-access|openaccess)(?::|\s+)/i, "").trim();
	if (!clean) throw new Error("OA recovery requires a DOI, for example oa:10.1038/nature12373.");
	return clean;
}

function normalizeDoi(raw: string): string {
	let clean = raw.trim();
	clean = clean.replace(/^doi:\s*/i, "");
	clean = clean.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
	clean = clean.replace(/^["“”']+|["“”']+$/g, "").trim();
	if (!/^10\.\d{4,}\/\S+$/i.test(clean)) {
		throw new Error(`No DOI found in "${raw}". OA recovery needs a DOI, for example oa:10.1038/nature12373.`);
	}
	return clean;
}

function doiUrl(doi: string): string {
	return `https://doi.org/${doi}`;
}

function unpaywallEmail(): string | undefined {
	return process.env.UNPAYWALL_EMAIL?.trim() || process.env.NCBI_EMAIL?.trim() || undefined;
}

async function fetchJson(url: URL, accept = "application/json"): Promise<{ status: number; payload: unknown }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: { accept },
			signal: controller.signal,
		});
		if (response.status === 404) return { status: 404, payload: undefined };
		if (!response.ok) {
			throw new Error(`OA recovery request failed: ${response.status} ${response.statusText}`);
		}
		return { status: response.status, payload: await response.json() };
	} finally {
		clearTimeout(timeout);
	}
}

type OaLocation = {
	hostType?: string;
	license?: string;
	pmcid?: string;
	title?: string;
	url: string;
	version?: string;
	via: "unpaywall" | "europepmc" | "core";
};

function parseUnpaywallLocation(payload: unknown): { isOa?: boolean; location?: OaLocation; oaStatus?: string } {
	const record = recordValue(payload);
	const best = recordValue(record.best_oa_location);
	const url = stringValue(best.url_for_pdf) ?? stringValue(best.url);
	if (!url) return { isOa: record.is_oa === true, oaStatus: stringValue(record.oa_status) };
	return {
		isOa: record.is_oa === true,
		oaStatus: stringValue(record.oa_status),
		location: {
			url,
			via: "unpaywall",
			version: stringValue(best.version),
			license: stringValue(best.license),
			hostType: stringValue(best.host_type),
			title: stringValue(record.title),
		},
	};
}

async function tryUnpaywall(doi: string, endpoints: string[], attempted: string[]): Promise<{ location?: OaLocation; meta: Record<string, unknown> }> {
	const email = unpaywallEmail();
	if (!email) {
		attempted.push("unpaywall:skipped(no email)");
		return { meta: {} };
	}
	const url = new URL(`${UNPAYWALL_BASE}/${doi}`);
	url.search = new URLSearchParams({ email }).toString();
	endpoints.push(url.toString());
	try {
		const { status, payload } = await withUnpaywallPacing(() => fetchJson(url));
		if (status === 404 || !payload) {
			attempted.push("unpaywall:miss");
			return { meta: {} };
		}
		const { isOa, location, oaStatus } = parseUnpaywallLocation(payload);
		if (!location) {
			attempted.push("unpaywall:miss");
			return { meta: { ...(isOa !== undefined ? { is_oa: isOa } : {}), ...(oaStatus ? { oa_status: oaStatus } : {}) } };
		}
		attempted.push("unpaywall:hit");
		return { location, meta: { ...(isOa !== undefined ? { is_oa: isOa } : {}), ...(oaStatus ? { oa_status: oaStatus } : {}) } };
	} catch (error) {
		attempted.push(`unpaywall:error(${error instanceof Error ? error.message : "unknown"})`);
		return { meta: {} };
	}
}

async function tryEuropePmc(doi: string, endpoints: string[], attempted: string[]): Promise<{ location?: OaLocation }> {
	const url = new URL(EUROPE_PMC_SEARCH_URL);
	url.search = new URLSearchParams({
		query: `DOI:"${doi}"`,
		resultType: "lite",
		cursorMark: "*",
		pageSize: "5",
		format: "json",
	}).toString();
	endpoints.push(url.toString());
	try {
		const { payload } = await fetchJson(url);
		const hits = arrayValue(recordValue(recordValue(payload).resultList).result).map(recordValue);
		// inPMC=Y is the operable criterion: the existing Europe PMC
		// full-text reader serves exactly what lives in PMC, so no separate
		// JATS fetch is needed to confirm readability here.
		const hit = hits.find((item) => String(item.inPMC ?? "").trim().toUpperCase() === "Y" && stringValue(item.pmcid));
		if (!hit) {
			attempted.push("europepmc:miss");
			return {};
		}
		const pmcid = stringValue(hit.pmcid)!.toUpperCase();
		attempted.push("europepmc:hit");
		return {
			location: {
				url: `https://europepmc.org/articles/${encodeURIComponent(pmcid)}`,
				via: "europepmc",
				pmcid,
				license: stringValue(hit.license),
				title: stringValue(hit.title),
			},
		};
	} catch (error) {
		attempted.push(`europepmc:error(${error instanceof Error ? error.message : "unknown"})`);
		return {};
	}
}

async function tryCore(doi: string, endpoints: string[], attempted: string[]): Promise<{ location?: OaLocation }> {
	try {
		const result = await searchCore({ query: `doi:${doi}`, limit: 5 });
		for (const endpoint of arrayValue(recordValue(result.provenance).endpoints)) {
			const value = stringValue(endpoint);
			if (value) endpoints.push(value);
		}
		const hit = arrayValue(result.results)
			.map(recordValue)
			.find((row) => row.hasFullText === true && stringValue(row.downloadUrl));
		if (!hit) {
			attempted.push("core:miss");
			return {};
		}
		attempted.push("core:hit");
		return {
			location: {
				url: stringValue(hit.downloadUrl)!,
				via: "core",
				title: stringValue(hit.title),
			},
		};
	} catch (error) {
		attempted.push(`core:error(${error instanceof Error ? error.message : "unknown"})`);
		return {};
	}
}

export async function searchOaRecovery(params: SearchParams): Promise<Record<string, unknown>> {
	const query = cleanQuery(params.query);
	const doi = normalizeDoi(query);
	const endpoints: string[] = [];
	const attempted: string[] = [];

	const unpaywall = await tryUnpaywall(doi, endpoints, attempted);
	let location = unpaywall.location;
	if (!location) {
		location = (await tryEuropePmc(doi, endpoints, attempted)).location;
	}
	if (!location) {
		location = (await tryCore(doi, endpoints, attempted)).location;
	}

	const recovered = Boolean(location);
	return {
		schema: "hypatia.oaRecovery.v1",
		source: "oa",
		query: params.query.trim(),
		doi,
		doiUrl: doiUrl(doi),
		recovered,
		...unpaywall.meta,
		...(location ? { oaLocation: location } : {}),
		recovery: {
			attempted,
			...(recovered
				? { disclosure: `Full text (if fetched) comes from ${location!.url} via ${location!.via}, not from the originally requested ${doiUrl(doi)}. Cite the version actually read${location!.version ? ` (${location!.version})` : ""}.` }
				: { disclosure: "No legal open-access copy found via Unpaywall, Europe PMC, or CORE. The DOI may still resolve to a paywalled publisher page." }),
		},
		provenance: {
			docs: [UNPAYWALL_DOCS, "https://europepmc.org/RestfulWebService", "https://api.core.ac.uk/docs/v3"],
			endpoints,
		},
	};
}

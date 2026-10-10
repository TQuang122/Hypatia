import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { registerScienceDatabaseTools } from "../extensions/research-tools/science-databases.js";

type Tool = {
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
	name: string;
	promptGuidelines?: string[];
	promptSnippet?: string;
};

const originalFetch = globalThis.fetch;
const originalNcbiEmail = process.env.NCBI_EMAIL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalNcbiEmail === undefined) delete process.env.NCBI_EMAIL;
	else process.env.NCBI_EMAIL = originalNcbiEmail;
});

function registerTools(): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	registerScienceDatabaseTools({
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
	} as never);
	return tools;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

test("science database tool searches PubMed through ESearch and ESummary", async () => {
	process.env.NCBI_EMAIL = "research@example.edu";
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("/esearch.fcgi")) {
			return jsonResponse({
				esearchresult: {
					count: "2",
					idlist: ["123", "456"],
					querytranslation: "crispr cancer",
				},
			});
		}
		if (url.includes("/esummary.fcgi")) {
			return jsonResponse({
				result: {
					uids: ["123", "456"],
					"123": {
						uid: "123",
						title: "CRISPR screen in cancer.",
						fulljournalname: "Example Journal",
						pubdate: "2026 Jan",
						authors: [{ name: "Ada A" }, { name: "Turing T" }],
						articleids: [{ idtype: "doi", value: "10.1000/example" }],
						pubtype: ["Journal Article"],
					},
					"456": {
						uid: "456",
						title: "Second result.",
						source: "Nature",
						pubdate: "2025 Dec",
						authors: [],
					},
				},
			});
		}
		throw new Error(`unexpected URL ${url}`);
	};

	const tools = registerTools();
	const result = await tools.get("hypatia_science_database_search")?.execute("call-1", {
		source: "pubmed",
		query: "CRISPR cancer",
		limit: 2,
		sort: "pub_date",
	});
	const details = result?.details as { results: Array<{ doi?: string; pmid: string; title: string }>; returned: number; source: string };

	assert.equal(tools.has("hypatia_science_database_search"), true);
	assert.equal(details.source, "pubmed");
	assert.equal(details.returned, 2);
	assert.equal(details.results[0]?.pmid, "123");
	assert.equal(details.results[0]?.doi, "10.1000/example");
	assert.match(details.results[0]?.title ?? "", /CRISPR/);
	assert.equal(new URL(requests[0]!).searchParams.get("tool"), "hypatia");
	assert.equal(new URL(requests[0]!).searchParams.get("email"), "research@example.edu");
	assert.equal(new URL(requests[0]!).searchParams.get("sort"), "pub_date");
	assert.equal(new URL(requests[1]!).searchParams.get("id"), "123,456");
	assert.match(tools.get("hypatia_science_database_search")?.promptSnippet ?? "", /PubMed/);
});

test("science database tool searches literature sources and looks up arXiv IDs", async () => {
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("api.crossref.org")) {
			return jsonResponse({
				message: {
					"total-results": 1,
					items: [{
						DOI: "10.1234/crossref",
						title: ["Crossref CRISPR metadata"],
						"container-title": ["Metadata Journal"],
						"published-online": { "date-parts": [[2026, 2, 3]] },
						author: [{ given: "Ada", family: "Lovelace" }],
						"is-referenced-by-count": 12,
						URL: "https://doi.org/10.1234/crossref",
						type: "journal-article",
					}],
				},
			});
		}
		if (url.includes("europepmc")) {
			return jsonResponse({
				hitCount: 1,
				nextCursorMark: "next",
				resultList: {
					result: [{
						id: "12345678",
						source: "MED",
						pmid: "12345678",
						pmcid: "PMC123456",
						doi: "10.1234/epmc",
						title: "Europe PMC CRISPR record",
						authorString: "Lovelace A",
						journalTitle: "Life Science Journal",
						pubYear: "2026",
						pubType: "research-article",
						citedByCount: "7",
						isOpenAccess: "Y",
						inPMC: "Y",
						hasReferences: "Y",
						hasTextMinedTerms: "Y",
					}],
				},
			});
		}
		if (url.includes("export.arxiv.org")) {
			return new Response([
				"<?xml version='1.0' encoding='UTF-8'?>",
				"<feed xmlns:opensearch='http://a9.com/-/spec/opensearch/1.1/' xmlns:arxiv='http://arxiv.org/schemas/atom' xmlns='http://www.w3.org/2005/Atom'>",
				"<opensearch:totalResults>1</opensearch:totalResults>",
				"<entry>",
				"<id>https://arxiv.org/abs/2601.01234v1</id>",
				"<title> arXiv CRISPR preprint </title>",
				"<summary> CRISPR preprint summary. </summary>",
				"<published>2026-01-02T00:00:00Z</published>",
				"<updated>2026-01-03T00:00:00Z</updated>",
				"<author><name>Ada Lovelace</name></author>",
				"<arxiv:primary_category term='q-bio.BM'/>",
				"<category term='q-bio.BM'/>",
				"<arxiv:doi>10.1234/arxiv</arxiv:doi>",
				"<arxiv:journal_ref>Preprint Journal</arxiv:journal_ref>",
				"<link href='https://arxiv.org/pdf/2601.01234v1' title='pdf' type='application/pdf'/>",
				"</entry>",
				"</feed>",
			].join(""), { status: 200, headers: { "content-type": "application/atom+xml" } });
		}
		throw new Error(`unexpected URL ${url}`);
	};

	const tools = registerTools();
	const crossref = await tools.get("hypatia_science_database_search")?.execute("call-crossref", {
		source: "crossref",
		query: "crispr metadata",
		limit: 1,
	});
	const europepmc = await tools.get("hypatia_science_database_search")?.execute("call-epmc", {
		source: "europepmc",
		query: "crispr",
		limit: 1,
	});
	const arxiv = await tools.get("hypatia_science_database_search")?.execute("call-arxiv", {
		source: "arxiv",
		query: "2601.01234v1",
	});

	const crossrefDetails = crossref?.details as { results: Array<{ doi?: string; title?: string }> };
	const europePmcDetails = europepmc?.details as { hasMore: boolean; results: Array<{ pmcid?: string; pmid?: string; url?: string }> };
	const arxivDetails = arxiv?.details as { results: Array<{ id_versioned?: string; pdf_url?: string; primary_category?: string }> };

	assert.equal(crossrefDetails.results[0]?.doi, "10.1234/crossref");
	assert.equal(crossrefDetails.results[0]?.title, "Crossref CRISPR metadata");
	assert.equal(europePmcDetails.hasMore, true);
	assert.equal(europePmcDetails.results[0]?.pmid, "12345678");
	assert.equal(europePmcDetails.results[0]?.pmcid, "PMC123456");
	assert.equal(europePmcDetails.results[0]?.url, "https://europepmc.org/article/MED/12345678");
	assert.equal(arxivDetails.results[0]?.id_versioned, "2601.01234v1");
	assert.equal(arxivDetails.results[0]?.primary_category, "q-bio.BM");
	assert.equal(arxivDetails.results[0]?.pdf_url, "https://arxiv.org/pdf/2601.01234v1");
	assert.equal(new URL(requests[0]!).searchParams.get("rows"), "1");
	assert.equal(new URL(requests[1]!).searchParams.get("resultType"), "lite");
	assert.equal(new URL(requests[2]!).searchParams.get("id_list"), "2601.01234v1");
	assert.match(tools.get("hypatia_science_database_search")?.promptSnippet ?? "", /Europe PMC/);
});

test("science database tool searches bioRxiv and medRxiv preprint sources", async () => {
	const requests: Array<{ body?: string; method: string; url: string }> = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
		if (url.includes("api.biorxiv.org/details/biorxiv")) {
			return jsonResponse({
				collection: [{
					doi: "10.1101/2026.01.01.000001",
					title: "Kinase biology preprint",
					authors: "Lovelace A",
					date: "2026-01-02",
					version: "1",
					type: "new results",
					license: "cc_by",
					category: "cell biology",
					abstract: "A kinase biology study.",
					published: "NA",
				}],
			});
		}
		if (url.includes("api.biorxiv.org/details/medrxiv")) {
			return jsonResponse({
				collection: [{
					doi: "10.1101/2020.09.09.20191205",
					title: "Clinical preprint",
					authors: "Turing A",
					date: "2020-09-10",
					version: "2",
					type: "new results",
					license: "cc_by_nc_nd",
					category: "infectious diseases",
					abstract: "A clinical preprint.",
					published: "NA",
				}],
			});
		}
		throw new Error(`unexpected URL ${url}`);
	};

	const tools = registerTools();
	const biorxiv = await tools.get("hypatia_science_database_search")?.execute("call-biorxiv", {
		source: "biorxiv",
		query: "kinase",
		limit: 1,
	});
	const medrxiv = await tools.get("hypatia_science_database_search")?.execute("call-medrxiv", {
		source: "medrxiv",
		query: "10.1101/2020.09.09.20191205",
		limit: 1,
	});

	const biorxivDetails = biorxiv?.details as { results: Array<{ doi?: string; title?: string }>; searchMode: string };
	const medrxivDetails = medrxiv?.details as { results: Array<{ doi?: string; url?: string }>; searchMode: string };

	assert.equal(biorxivDetails.searchMode, "recent-60-day-filter");
	assert.equal(biorxivDetails.results[0]?.title, "Kinase biology preprint");
	assert.equal(medrxivDetails.searchMode, "doi");
	assert.equal(medrxivDetails.results[0]?.doi, "10.1101/2020.09.09.20191205");
	assert.match(tools.get("hypatia_science_database_search")?.promptSnippet ?? "", /bioRxiv/);
});

test("Crossref requests run one at a time at the pool's pace", async () => {
	const { withCrossrefPacing } = await import("../extensions/research-tools/science-databases.js");
	const starts: number[] = [];
	let running = 0;
	let maxRunning = 0;
	const request = () => withCrossrefPacing(true, async () => {
		starts.push(Date.now());
		running += 1;
		maxRunning = Math.max(maxRunning, running);
		await new Promise((resolve) => setTimeout(resolve, 20));
		running -= 1;
	});
	await Promise.all([request(), request(), request()]);
	assert.equal(maxRunning, 1);
	for (let index = 1; index < starts.length; index += 1) {
		assert.ok(starts[index]! - starts[index - 1]! >= 390, `gap ${starts[index]! - starts[index - 1]!}ms`);
	}
});

test("a failed database request names the service that failed", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("down", { status: 503, statusText: "Service Temporarily Unavailable" })) as typeof fetch;
	try {
		const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
		registerScienceDatabaseTools({ registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool), on: () => () => {} } as never);
		await assert.rejects(
			tools.get("hypatia_science_database_search")!.execute("x", { source: "europepmc", query: "crispr" }),
			/www\.ebi\.ac\.uk request failed: 503 Service Temporarily Unavailable/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("science database tool searches CORE with an API key", async () => {
	const originalKey = process.env.CORE_API_KEY;
	process.env.CORE_API_KEY = "test-core-key";
	const requests: Array<{ auth?: string; url: string }> = [];
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		const headers = recordFromInit(init);
		requests.push({ url, auth: headers.authorization });
		return jsonResponse({
			totalHits: 2,
			limit: 2,
			offset: 0,
			results: [
				{
					id: 5520176,
					title: "Structural studies of CRISPR-associated proteins",
					authors: [{ name: "Reeks, Judith" }],
					abstract: "CRISPRs act to prevent viral infection in prokaryotes.",
					doi: "10.1000/core-example",
					yearPublished: 2013,
					publishedDate: "2013-01-01",
					publisher: "Example Repository",
					documentType: "Thesis",
					citationCount: 4,
					downloadUrl: "https://core.ac.uk/download/5520176.pdf",
					fullText: "Full text body.",
				},
				{
					id: 5520177,
					title: "Metadata-only record",
					authors: [],
				},
			],
		});
	}) as typeof fetch;

	try {
		const tools = registerTools();
		const result = await tools.get("hypatia_science_database_search")?.execute("call-core", {
			source: "core",
			query: "CRISPR",
			limit: 2,
		});
		const details = result?.details as {
			credentialStatus: string;
			results: Array<{ core_id: number; doi?: string; downloadUrl?: string; hasFullText: boolean; title: string }>;
			returned: number;
			source: string;
			totalCount: number;
		};

		assert.equal(details.source, "core");
		assert.equal(details.totalCount, 2);
		assert.equal(details.returned, 2);
		assert.equal(details.results[0]?.title, "Structural studies of CRISPR-associated proteins");
		assert.equal(details.results[0]?.hasFullText, true);
		assert.equal(details.results[0]?.downloadUrl, "https://core.ac.uk/download/5520176.pdf");
		assert.equal(details.results[1]?.hasFullText, false);
		assert.equal(details.credentialStatus, "CORE_API_KEY present");
		assert.equal(requests[0]?.auth, "Bearer test-core-key");
		assert.equal(new URL(requests[0]!.url).searchParams.get("q"), "CRISPR");
		assert.match(new URL(requests[0]!.url).pathname, /\/v3\/search\/works\/$/);
	} finally {
		if (originalKey === undefined) delete process.env.CORE_API_KEY;
		else process.env.CORE_API_KEY = originalKey;
	}
});

test("science database tool marks CORE results metadata-only without an API key", async () => {
	const originalKey = process.env.CORE_API_KEY;
	delete process.env.CORE_API_KEY;
	globalThis.fetch = (async () => jsonResponse({
		totalHits: 1,
		results: [{
			id: 1,
			title: "Anonymous record",
			authors: [{ name: "Doe J" }],
			fullText: "Not available for public API users.",
		}],
	})) as typeof fetch;

	try {
		const tools = registerTools();
		const result = await tools.get("hypatia_science_database_search")?.execute("call-core-anon", {
			source: "core",
			query: "doi:10.1000/anonymous fulltext_only=true",
			limit: 5,
		});
		const details = result?.details as {
			credentialStatus: string;
			note?: string;
			results: Array<unknown>;
			returned: number;
		};

		assert.equal(details.returned, 0);
		assert.match(details.credentialStatus, /CORE_API_KEY missing/);
		assert.match(details.note ?? "", /metadata-only/);
	} finally {
		if (originalKey === undefined) delete process.env.CORE_API_KEY;
		else process.env.CORE_API_KEY = originalKey;
	}
});

test("science database tool searches DOAB books and prefers PDF bitstreams", async () => {
	const requests: Array<{ accept?: string; url: string }> = [];
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		const headers = recordFromInit(init);
		requests.push({ url, accept: headers.accept });
		return jsonResponse([
			{
				uuid: "uuid-1",
				handle: "20.500.12854/26303",
				metadata: [
					{ key: "dc.title", value: "Open Access Books" },
					{ key: "dc.contributor.author", value: "Doe, Jane" },
					{ key: "dc.identifier.isbn", value: "978-0-262-03561-3" },
					{ key: "oapen.identifier.doi", value: "10.1000/doab-example" },
					{ key: "publisher.name", value: "Example Press" },
					{ key: "dc.date.issued", value: "2024" },
					{ key: "dc.type", value: "book" },
					{ key: "dc.rights.uri", value: "https://creativecommons.org/licenses/by/4.0/" },
				],
				bitstreams: [
					{ name: "cover.jpg", format: "JPEG", mimeType: "image/jpeg", bundleName: "THUMBNAIL", retrieveLink: "/rest/bitstreams/cover/retrieve" },
					{ name: "book.pdf", format: "Adobe PDF", mimeType: "application/pdf", bundleName: "ORIGINAL", retrieveLink: "/rest/bitstreams/pdf/retrieve" },
				],
			},
			{
				uuid: "uuid-2",
				handle: "20.500.12854/99999",
				metadata: [
					{ key: "dc.title", value: "Cover Only Book" },
					{ key: "dc.identifier.uri", value: "https://directory.doabooks.org/handle/20.500.12854/99999" },
				],
				bitstreams: [
					{ name: "cover.jpg", format: "JPEG", mimeType: "image/jpeg", bundleName: "THUMBNAIL", retrieveLink: "/rest/bitstreams/cover2/retrieve" },
				],
			},
			{
				uuid: "uuid-3",
				handle: "20.500.12854/00000",
				metadata: [{ key: "dc.publisher", value: "No title record" }],
				bitstreams: [],
			},
		]);
	}) as typeof fetch;

	const tools = registerTools();
	const result = await tools.get("hypatia_science_database_search")?.execute("call-doab", {
		source: "doab",
		query: "open access",
		limit: 5,
	});
	const details = result?.details as {
		results: Array<{ doi?: string; doiUrl?: string; isbns?: string[]; license?: string; openAccessUrl?: string; publisher?: string; title: string; type?: string }>;
		returned: number;
		source: string;
	};

	assert.equal(details.source, "doab");
	assert.equal(details.returned, 2);
	assert.equal(details.results[0]?.title, "Open Access Books");
	assert.equal(details.results[0]?.openAccessUrl, "https://directory.doabooks.org/rest/bitstreams/pdf/retrieve");
	assert.deepEqual(details.results[0]?.isbns, ["9780262035613"]);
	assert.equal(details.results[0]?.doi, "10.1000/doab-example");
	assert.equal(details.results[0]?.doiUrl, "https://doi.org/10.1000/doab-example");
	assert.equal(details.results[0]?.publisher, "Example Press");
	assert.equal(details.results[0]?.type, "book");
	assert.equal(details.results[0]?.license, "https://creativecommons.org/licenses/by/4.0/");
	assert.equal(details.results[1]?.openAccessUrl, "https://directory.doabooks.org/handle/20.500.12854/99999");
	const params = new URL(requests[0]!.url).searchParams;
	assert.equal(params.get("query"), "open access");
	assert.equal(params.get("expand"), "metadata,bitstreams");
	assert.equal(params.get("limit"), "5");
	assert.equal(requests[0]?.accept, "application/json");
	assert.match(tools.get("hypatia_science_database_search")?.promptSnippet ?? "", /DOAB/);
});

test("science search accepts the \"null\" some models send for omitted optional fields", async () => {
	const { validateToolArguments } = await import("@earendil-works/pi-ai");
	const tools = new Map<string, { prepareArguments: (args: unknown) => unknown; parameters: unknown; name: string }>();
	registerScienceDatabaseTools({ registerTool: (tool: never) => tools.set((tool as { name: string }).name, tool), on: () => () => {} } as never);
	const tool = tools.get("hypatia_science_database_search")!;
	const validate = (args: Record<string, unknown>) =>
		validateToolArguments(tool as never, { type: "toolCall", id: "t", name: tool.name, arguments: tool.prepareArguments(args) as never });

	assert.deepEqual(validate({ source: "openalex", query: "x", sort: "null" }), { source: "openalex", query: "x" });
	assert.deepEqual(validate({ source: "pubmed", query: "x", sort: " Relevance ", limit: "5" }), { source: "pubmed", query: "x", sort: "relevance", limit: 5 });
	assert.throws(() => validate({ source: "pubmed", query: "x", sort: "newest" }), /sort/);
});

function recordFromInit(init: { headers?: unknown } | undefined): Record<string, string> {
	const headers = init?.headers;
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
	const record: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (typeof value === "string") record[key.toLowerCase()] = value;
	}
	return record;
}

function withOaEnv(email: string | undefined, run: () => Promise<void>): Promise<void>;
function withOaEnv(run: () => Promise<void>): Promise<void>;
async function withOaEnv(first: string | undefined | (() => Promise<void>), second?: () => Promise<void>): Promise<void> {
	const run = typeof first === "function" ? first : second!;
	const email = typeof first === "function" ? undefined : first;
	const originalUnpaywall = process.env.UNPAYWALL_EMAIL;
	const originalNcbi = process.env.NCBI_EMAIL;
	if (email === undefined) {
		delete process.env.UNPAYWALL_EMAIL;
		delete process.env.NCBI_EMAIL;
	} else {
		process.env.UNPAYWALL_EMAIL = email;
	}
	try {
		await run();
	} finally {
		if (originalUnpaywall === undefined) delete process.env.UNPAYWALL_EMAIL;
		else process.env.UNPAYWALL_EMAIL = originalUnpaywall;
		if (originalNcbi === undefined) delete process.env.NCBI_EMAIL;
		else process.env.NCBI_EMAIL = originalNcbi;
	}
}

test("science database tool recovers open access via Unpaywall first", async () => {
	const requests: string[] = [];
	globalThis.fetch = (async (input) => {
		const url = String(input);
		requests.push(url);
		return jsonResponse({
			doi: "10.1038/nature12373",
			title: "Measurement of the Higgs boson mass",
			is_oa: true,
			oa_status: "bronze",
			best_oa_location: {
				url_for_pdf: "https://www.nature.com/articles/nature12373.pdf",
				url: "https://www.nature.com/articles/nature12373.pdf",
				url_for_landing_page: "https://doi.org/10.1038/nature12373",
				host_type: "publisher",
				version: "publishedVersion",
				license: null,
			},
		});
	}) as typeof fetch;

	await withOaEnv("research@example.edu", async () => {
		const tools = registerTools();
		const result = await tools.get("hypatia_science_database_search")?.execute("call-oa", {
			source: "oa",
			query: "oa:10.1038/nature12373",
		});
		const details = result?.details as {
			doi: string;
			oaLocation?: { license?: string; url: string; version?: string; via: string };
			recovered: boolean;
			recovery: { attempted: string[]; disclosure: string };
			schema: string;
		};

		assert.equal(details.schema, "hypatia.oaRecovery.v1");
		assert.equal(details.doi, "10.1038/nature12373");
		assert.equal(details.recovered, true);
		assert.equal(details.oaLocation?.via, "unpaywall");
		assert.equal(details.oaLocation?.url, "https://www.nature.com/articles/nature12373.pdf");
		assert.equal(details.oaLocation?.version, "publishedVersion");
		assert.deepEqual(details.recovery.attempted, ["unpaywall:hit"]);
		assert.match(details.recovery.disclosure, /cite the version actually read/i);
		assert.equal(requests.length, 1);
		assert.match(requests[0]!, /api\.unpaywall\.org\/v2\/10\.1038\/nature12373/);
		assert.equal(new URL(requests[0]!).searchParams.get("email"), "research@example.edu");
	});
});

test("science database tool falls through to Europe PMC when Unpaywall misses", async () => {
	globalThis.fetch = (async (input) => {
		const url = String(input);
		if (url.includes("api.unpaywall.org")) {
			return new Response("not found", { status: 404, statusText: "Not Found" });
		}
		if (url.includes("www.ebi.ac.uk")) {
			return jsonResponse({
				hitCount: 1,
				resultList: { result: [{
					id: "123",
					source: "MED",
					pmcid: "PMC9046468",
					title: "Example biomedical paper",
					inPMC: "Y",
					isOpenAccess: "Y",
					license: "cc-by",
				}] },
			});
		}
		throw new Error(`unexpected URL ${url}`);
	}) as typeof fetch;

	await withOaEnv("research@example.edu", async () => {
		const tools = registerTools();
		const result = await tools.get("hypatia_science_database_search")?.execute("call-oa-epmc", {
			source: "oa",
			query: "https://doi.org/10.1000/epmc-example",
		});
		const details = result?.details as {
			oaLocation?: { pmcid?: string; url: string; via: string };
			recovered: boolean;
			recovery: { attempted: string[] };
		};

		assert.equal(details.recovered, true);
		assert.equal(details.oaLocation?.via, "europepmc");
		assert.equal(details.oaLocation?.pmcid, "PMC9046468");
		assert.equal(details.oaLocation?.url, "https://europepmc.org/articles/PMC9046468");
		assert.deepEqual(details.recovery.attempted, ["unpaywall:miss", "europepmc:hit"]);
	});
});

test("science database tool reports no recovery when every step misses", async () => {
	globalThis.fetch = (async (input) => {
		const url = String(input);
		if (url.includes("api.unpaywall.org")) {
			return new Response("not found", { status: 404, statusText: "Not Found" });
		}
		if (url.includes("www.ebi.ac.uk")) {
			return jsonResponse({ hitCount: 0 });
		}
		if (url.includes("api.core.ac.uk")) {
			return jsonResponse({ totalHits: 0, results: [] });
		}
		throw new Error(`unexpected URL ${url}`);
	}) as typeof fetch;

	await withOaEnv("research@example.edu", async () => {
		const tools = registerTools();
		const result = await tools.get("hypatia_science_database_search")?.execute("call-oa-miss", {
			source: "oa",
			query: "oa:10.1000/no-oa-copy",
		});
		const details = result?.details as {
			recovered: boolean;
			recovery: { attempted: string[]; disclosure: string };
		};

		assert.equal(details.recovered, false);
		assert.deepEqual(details.recovery.attempted, ["unpaywall:miss", "europepmc:miss", "core:miss"]);
		assert.match(details.recovery.disclosure, /no legal open-access copy/i);
	});
});

test("science database tool skips Unpaywall without an email and rejects non-DOIs", async () => {
	globalThis.fetch = (async (input) => {
		const url = String(input);
		if (url.includes("www.ebi.ac.uk")) {
			return jsonResponse({ hitCount: 0 });
		}
		if (url.includes("api.core.ac.uk")) {
			return jsonResponse({ totalHits: 0, results: [] });
		}
		throw new Error(`unexpected URL ${url}`);
	}) as typeof fetch;

	await withOaEnv(async () => {
		const tools = registerTools();
		const result = await tools.get("hypatia_science_database_search")?.execute("call-oa-noemail", {
			source: "oa",
			query: "10.1000/no-email",
		});
		const details = result?.details as { recovered: boolean; recovery: { attempted: string[] } };
		assert.equal(details.recovered, false);
		assert.ok(details.recovery.attempted[0]?.startsWith("unpaywall:skipped"));

		await assert.rejects(
			tools.get("hypatia_science_database_search")!.execute("call-oa-bad", { source: "oa", query: "not a doi" }),
			/No DOI found/,
		);
	});
});

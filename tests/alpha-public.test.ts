import assert from "node:assert/strict";
import test from "node:test";

import {
	alphaXivSearchPayload,
	discoverPublicAlphaXiv,
	findPublicAlphaXivImplementations,
	normalizeAlphaXivPaperId,
	readPublicAlphaXivPaper,
	searchPublicAlphaXivFast,
} from "../src/alpha-public.js";

test("public alphaXiv discovery uses the keyless keyword or embedding endpoint and maps hits", async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		requests.push({ url: new URL(String(input)), init });
		return Response.json([{
			paperId: "2401.12345",
			title: "A Public AlphaXiv Paper",
			abstract: "Abstract text",
			publicationDate: "2024-01-02",
			votes: 3,
			snippets: [{ pageNumber: 2, snippet: "Matched passage" }],
		}]);
	};

	const hits = await discoverPublicAlphaXiv("  test query  ", "embedding", {
		apiBaseUrl: "https://api.example.test/",
		fetchImpl,
	});
	assert.equal(requests[0]?.url.origin, "https://api.example.test");
	assert.equal(requests[0]?.url.pathname, "/search/v2/paper/discover/embedding");
	assert.equal(requests[0]?.url.searchParams.get("q"), "test query");
	assert.equal(requests[0]?.url.searchParams.get("prioritize"), "default");
	assert.equal(new Headers(requests[0]?.init?.headers).has("authorization"), false);

	const payload = alphaXivSearchPayload("test query", "semantic", hits);
	assert.equal(payload.source, "alphaxiv");
	assert.equal(payload.results?.[0]?.arxivId, "2401.12345");
	assert.equal(payload.results?.[0]?.likes, 3);
	assert.equal(payload.results?.[0]?.publishedAt, "2024-01-02");
	assert.deepEqual(payload.results?.[0]?.snippets, [{ pageNumber: 2, snippet: "Matched passage" }]);
});

test("public alphaXiv both mode keeps semantic and keyword groups separate", () => {
	const semantic = [{ paperId: "2401.12345", title: "Semantic result", abstract: "", snippets: [] }];
	const keyword = [{ paperId: "2402.12345", title: "Keyword result", abstract: "", snippets: [] }];
	const payload = alphaXivSearchPayload("query", "both", semantic, keyword);
	assert.equal(payload.semantic?.results[0]?.title, "Semantic result");
	assert.equal(payload.keyword?.results[0]?.title, "Keyword result");
});

test("public discovery sends date and ranking filters and applies the output limit", async () => {
	let requestUrl: URL | undefined;
	const fetchImpl: typeof fetch = async (input, init) => {
		requestUrl = new URL(String(input));
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		return Response.json(Array.from({ length: 4 }, (_, index) => ({
			paperId: `240${index + 1}.12345`,
			title: `Result ${index + 1}`,
			abstract: "",
			snippets: [],
		})));
	};
	const hits = await discoverPublicAlphaXiv("query", "keyword", {
		apiBaseUrl: "https://api.example.test",
		fetchImpl,
		publishedAfter: "2024-01-01",
		publishedBefore: "2025-12-31",
		prioritize: "recency",
		limit: 2,
	});
	assert.equal(requestUrl?.searchParams.get("publishedAfter"), "2024-01-01");
	assert.equal(requestUrl?.searchParams.get("publishedBefore"), "2025-12-31");
	assert.equal(requestUrl?.searchParams.get("prioritize"), "recency");
	assert.equal(hits.length, 2);
});

test("public discovery rejects invalid date ranges and result limits before requesting", async () => {
	let requests = 0;
	const fetchImpl: typeof fetch = async () => {
		requests += 1;
		return Response.json([]);
	};
	await assert.rejects(
		discoverPublicAlphaXiv("query", "embedding", { fetchImpl, publishedAfter: "2025-01-01", publishedBefore: "2024-12-31" }),
		/publishedAfter must be on or before publishedBefore/u,
	);
	await assert.rejects(discoverPublicAlphaXiv("query", "keyword", { fetchImpl, publishedAfter: "2025-02-30" }), /valid calendar date/u);
	await assert.rejects(discoverPublicAlphaXiv("query", "keyword", { fetchImpl, limit: 201 }), /from 1 to 200/u);
	assert.equal(requests, 0);
});

test("fast public title search excludes private papers and maps its snippet", async () => {
	let requestUrl: URL | undefined;
	const fetchImpl: typeof fetch = async (input, init) => {
		requestUrl = new URL(String(input));
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		return Response.json([{ paperId: "1706.03762", title: "Attention Is All You Need", snippet: "Transformer architecture" }]);
	};
	const hits = await searchPublicAlphaXivFast("Attention Is All You Need", { apiBaseUrl: "https://api.example.test", fetchImpl });
	assert.equal(requestUrl?.pathname, "/search/v2/paper/fast");
	assert.equal(requestUrl?.searchParams.get("q"), "Attention Is All You Need");
	assert.equal(requestUrl?.searchParams.get("includePrivate"), "false");
	const payload = alphaXivSearchPayload("Attention Is All You Need", "title", hits);
	assert.equal(payload.results?.[0]?.title, "Attention Is All You Need");
	assert.deepEqual(payload.results?.[0]?.snippets, [{ snippet: "Transformer architecture" }]);
});

test("paper implementation lookup returns unique public GitHub repositories with author-first ranking", async () => {
	const requests: URL[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		requests.push(url);
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		if (url.pathname === "/papers/v3/2401.12345") {
			return Response.json({ universalId: "2401.12345", groupId: "group-1", title: "A Paper" });
		}
		if (url.pathname === "/papers/v3/group-1/implementations") {
			return Response.json({
				paperResources: [
					{ type: "github", url: "https://github.com/example/community", stars: 10, source: "community" },
					{ type: "github", url: "https://github.com/example/author", stars: 2, source: "author" },
					{ type: "github", url: "https://github.com/example/community", stars: 99, source: "community" },
					{ type: "website", url: "https://example.org/project", stars: 1000, source: "author" },
					{ type: "github", url: "http://github.com/example/insecure", stars: 100, source: "author" },
				],
				alphaXivImplementations: [{ type: "github", url: "https://github.com/example/community-2", stars: 30, source: "community" }],
			});
		}
		throw new Error(`unexpected URL ${url}`);
	};
	const result = await findPublicAlphaXivImplementations("https://arxiv.org/abs/2401.12345v2", {
		apiBaseUrl: "https://api.example.test",
		fetchImpl,
	});
	assert.equal(result.paperId, "2401.12345");
	assert.equal(result.title, "A Paper");
	assert.deepEqual(result.implementations, [
		{ url: "https://github.com/example/author", stars: 2, source: "author" },
		{ url: "https://github.com/example/community", stars: 99, source: "community" },
		{ url: "https://github.com/example/community-2", stars: 30, source: "community" },
	]);
	assert.deepEqual(requests.map((url) => url.pathname), [
		"/papers/v3/2401.12345",
		"/papers/v3/group-1/implementations",
	]);
});

test("public alphaXiv discovery retries a short Retry-After without adding credentials", async () => {
	let attempts = 0;
	const fetchImpl: typeof fetch = async (_input, init) => {
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		attempts += 1;
		if (attempts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
		return Response.json([{ paperId: "2401.12345", title: "Retried result", abstract: "", snippets: [] }]);
	};
	const hits = await discoverPublicAlphaXiv("query", "keyword", { fetchImpl });
	assert.equal(attempts, 2);
	assert.equal(hits[0]?.title, "Retried result");
});

test("paper IDs normalize arXiv and AlphaXiv URLs, preserving old-style archive IDs", () => {
	assert.equal(normalizeAlphaXivPaperId("https://arxiv.org/abs/2401.12345v2"), "2401.12345v2");
	assert.equal(normalizeAlphaXivPaperId("https://www.alphaxiv.org/overview/hep-th/9711200"), "hep-th/9711200");
	assert.equal(normalizeAlphaXivPaperId("arXiv:2401.12345 [cs.CL]"), "2401.12345");
});

test("paper read falls back from a missing overview to public extracted text", async () => {
	const requests: URL[] = [];
	const fetchImpl: typeof fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		return url.pathname.endsWith("/overview/2401.12345.md")
			? new Response("", { status: 404 })
			: new Response("# A Paper\n\nFull text.");
	};
	const result = await readPublicAlphaXivPaper("https://arxiv.org/abs/2401.12345", false, {
		webBaseUrl: "https://papers.example.test",
		fetchImpl,
	});
	assert.equal(result.kind, "abs");
	assert.match(result.content, /Full text/u);
	assert.equal(result.paperId, "2401.12345");
	assert.deepEqual(requests.map((url) => url.pathname), [
		"/overview/2401.12345.md",
		"/abs/2401.12345.md",
	]);
});

test("full-text read asks only for extracted text and hides request contents in errors", async () => {
	let requested = "";
	const fetchImpl: typeof fetch = async (input) => {
		requested = String(input);
		return new Response("", { status: 404 });
	};
	await assert.rejects(
		readPublicAlphaXivPaper("2401.12345", true, { fetchImpl }),
		/has not published extracted full text/u,
	);
	assert.match(requested, /\/abs\/2401\.12345\.md$/u);
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAlphaTools } from "../extensions/research-tools/alpha.js";

type AlphaTool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ details: Record<string, unknown> }> };

test("public alphaXiv search and paper reads work without login", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "hypatia-alpha-fallback-"));
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, fetch: globalThis.fetch };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		if (url.hostname === "api.alphaxiv.org" && url.pathname === "/search/v2/paper/discover/embedding") {
			return Response.json([{
				paperId: "2309.08600",
				title: "Sparse Autoencoders Find Highly Interpretable Features",
				abstract: "We use sparse autoencoders.",
				publicationDate: "2023-09-15",
				votes: 4,
				snippets: [],
			}]);
		}
		if (url.hostname === "www.alphaxiv.org" && url.pathname === "/overview/2309.08600.md") {
			return new Response("# Sparse Autoencoders Find Highly Interpretable Features in Language Models\n\n## Abstract\nWe use sparse autoencoders.\n\n## Methodology\nWe train sparse autoencoders.");
		}
		if (url.hostname === "www.alphaxiv.org" && /^\/(?:overview|abs)\/2309\.08601\.md$/u.test(url.pathname)) {
			return new Response("", { status: 404 });
		}
		if (url.hostname === "api.openalex.org") {
			return Response.json({ meta: { count: 1 }, results: [{ id: "https://openalex.org/W1", title: "Sparse Autoencoders Find Highly Interpretable Features", authorships: [] }] });
		}
		if (url.hostname === "export.arxiv.org") {
			return new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2309.08600v3</id><title>Sparse Autoencoders Find Highly Interpretable Features in Language Models</title><summary>We use sparse autoencoders.</summary><published>2023-09-15T00:00:00Z</published><author><name>Hoagy Cunningham</name></author></entry></feed>`);
		}
		throw new Error(`unexpected request ${url}`);
	}) as typeof fetch;
	t.after(() => {
		process.env.HOME = saved.HOME;
		process.env.USERPROFILE = saved.USERPROFILE;
		globalThis.fetch = saved.fetch;
	});

	const tools = new Map<string, AlphaTool>();
	registerAlphaTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as unknown as AlphaTool), on: () => () => {} } as unknown as ExtensionAPI, false);

	const search = await tools.get("alpha_search")!.execute("s", { query: "sparse autoencoders interpretability" });
	assert.equal(search.details.source, "alphaxiv");
	assert.equal((search.details.results as Array<Record<string, unknown>>)[0]?.arxivId, "2309.08600");

	const paper = await tools.get("alpha_get_paper")!.execute("p", { paper: "https://arxiv.org/abs/2309.08600", section: "methodology" });
	assert.equal(paper.details.source, "alphaxiv");
	assert.match(JSON.stringify(paper.details.content), /We train sparse autoencoders/);
	assert.deepEqual(paper.details.requestedSections, ["methodology"]);
	assert.deepEqual(paper.details.missingSections, []);
	const metadataFallback = await tools.get("alpha_get_paper")!.execute("p2", { paper: "2309.08601" });
	assert.match(String(metadataFallback.details.fallbackNote), /these results are from arXiv metadata and abstract/u);

	await assert.rejects(tools.get("alpha_get_paper")!.execute("q", { paper: "not-an-arxiv-id" }), /alphaXiv did not answer this call/);
});

test("alphaXiv public search falls back to OpenAlex when its public endpoint fails", async (t) => {
	const savedFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.hostname === "api.alphaxiv.org") return new Response("", { status: 503 });
		if (url.hostname === "api.openalex.org") {
			return Response.json({ meta: { count: 1 }, results: [{ id: "https://openalex.org/W1", title: "Fallback paper", authorships: [] }] });
		}
		throw new Error(`unexpected request ${url.hostname}`);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = savedFetch; });
	const tools = new Map<string, AlphaTool>();
	registerAlphaTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as unknown as AlphaTool), on: () => () => {} } as unknown as ExtensionAPI, false);
	const search = await tools.get("alpha_search")!.execute("s", { query: "sparse autoencoders" });
	assert.match(String(search.details.fallbackNote), /^alphaXiv did not answer \(AlphaXiv public search returned HTTP 503\.\); these results are from OpenAlex semantic search\.$/);
	assert.ok(Array.isArray(search.details.results));
});

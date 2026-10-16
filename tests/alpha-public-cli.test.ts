import assert from "node:assert/strict";
import test from "node:test";

import { runAlphaPublicCli } from "../src/alpha-public-cli.js";

test("alpha search CLI uses public semantic search without an auth header", async () => {
	const output: string[] = [];
	let requestUrl: URL | undefined;
	const handled = await runAlphaPublicCli(["search", "--mode", "semantic", "scaling laws"], {
		writeOutput: (text) => output.push(text),
		fetchImpl: async (input, init) => {
			requestUrl = new URL(String(input));
			assert.equal(new Headers(init?.headers).has("authorization"), false);
			return Response.json([{ paperId: "2401.12345", title: "Scaling Laws", abstract: "Abstract", snippets: [] }]);
		},
	});
	assert.equal(handled, true);
	assert.equal(requestUrl?.pathname, "/search/v2/paper/discover/embedding");
	assert.equal(requestUrl?.searchParams.get("q"), "scaling laws");
	assert.equal(JSON.parse(output[0]!).results[0].title, "Scaling Laws");
});

test("alpha search CLI passes discovery filters and result limit", async () => {
	const output: string[] = [];
	let requestUrl: URL | undefined;
	const handled = await runAlphaPublicCli([
		"search", "--published-after", "2024-01-01", "--published-before", "2025-12-31",
		"--prioritize", "popular", "--limit", "1", "query",
	], {
		writeOutput: (text) => output.push(text),
		fetchImpl: async (input, init) => {
			requestUrl = new URL(String(input));
			assert.equal(new Headers(init?.headers).has("authorization"), false);
			return Response.json([
				{ paperId: "2401.12345", title: "First", abstract: "", snippets: [] },
				{ paperId: "2402.12345", title: "Second", abstract: "", snippets: [] },
			]);
		},
	});
	assert.equal(handled, true);
	assert.equal(requestUrl?.searchParams.get("publishedAfter"), "2024-01-01");
	assert.equal(requestUrl?.searchParams.get("publishedBefore"), "2025-12-31");
	assert.equal(requestUrl?.searchParams.get("prioritize"), "popular");
	assert.equal(JSON.parse(output[0]!).results.length, 1);
});

test("alpha search CLI supports fast title lookup without private papers", async () => {
	const output: string[] = [];
	let requestUrl: URL | undefined;
	const handled = await runAlphaPublicCli(["search", "--mode=title", "Attention Is All You Need"], {
		writeOutput: (text) => output.push(text),
		fetchImpl: async (input, init) => {
			requestUrl = new URL(String(input));
			assert.equal(new Headers(init?.headers).has("authorization"), false);
			return Response.json([{ paperId: "1706.03762", title: "Attention Is All You Need", snippet: "Transformer architecture" }]);
		},
	});
	assert.equal(handled, true);
	assert.equal(requestUrl?.pathname, "/search/v2/paper/fast");
	assert.equal(requestUrl?.searchParams.get("includePrivate"), "false");
	assert.equal(JSON.parse(output[0]!).results[0].snippets[0].snippet, "Transformer architecture");
});

test("alpha implementations CLI resolves linked public GitHub repositories", async () => {
	const output: string[] = [];
	const handled = await runAlphaPublicCli(["implementations", "2401.12345"], {
		writeOutput: (text) => output.push(text),
		fetchImpl: async (input, init) => {
			const url = new URL(String(input));
			assert.equal(new Headers(init?.headers).has("authorization"), false);
			if (url.pathname === "/papers/v3/2401.12345") return Response.json({ universalId: "2401.12345", groupId: "g1", title: "Paper" });
			if (url.pathname === "/papers/v3/g1/implementations") return Response.json({ paperResources: [{ type: "github", url: "https://github.com/org/repo", stars: 7, source: "author" }] });
			throw new Error(`unexpected URL ${url}`);
		},
	});
	assert.equal(handled, true);
	assert.deepEqual(JSON.parse(output[0]!).implementations, [{ url: "https://github.com/org/repo", stars: 7, source: "author" }]);
});

test("title search rejects discovery-only date and ranking flags", async () => {
	await assert.rejects(
		runAlphaPublicCli(["search", "--mode", "title", "--published-after", "2025-01-01", "query"], {
			fetchImpl: async () => { throw new Error("should not fetch"); },
		}),
		/Date filters and ranking policies apply to semantic\/keyword discovery/u,
	);
});

test("alpha get CLI reads public Markdown and retains a local annotation", async () => {
	const output: string[] = [];
	const handled = await runAlphaPublicCli(["get", "2401.12345"], {
		writeOutput: (text) => output.push(text),
		fetchImpl: async () => new Response("# Paper\n\nBody."),
		readLocalAnnotation: (id) => ({ id, note: "Revisit" }),
	});
	assert.equal(handled, true);
	assert.match(output[0]!, /# Paper[\s\S]*\[Local note\][\s\S]*Revisit/u);
});

test("agentic and unsupported alpha commands remain delegated to alpha-hub", async () => {
	const fetchImpl: typeof fetch = async () => { throw new Error("should not fetch"); };
	assert.equal(await runAlphaPublicCli(["search", "--mode", "agentic", "query"], { fetchImpl }), false);
	assert.equal(await runAlphaPublicCli(["ask", "2401.12345", "question"], { fetchImpl }), false);
});

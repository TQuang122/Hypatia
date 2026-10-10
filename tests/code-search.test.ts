import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCodeSearchTool, searchCode } from "../extensions/research-tools/code-search.js";
import { registerContext7Mcp } from "../extensions/research-tools/context7-mcp.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const grepFixture = {
	hits: {
		total: { value: 2 },
		hits: [
			{
				repo: { raw: "pytorch/pytorch" },
				path: { raw: "torch/autograd/__init__.py" },
				branch: { raw: "main" },
				content: { snippet: "class <mark>Variable</mark>:" },
			},
			{
				repo: { raw: "jax-ml/jax" },
				path: { raw: "jax/_src/api.py" },
				content: { snippet: "def grad(" },
			},
		],
	},
};

test("code search returns repos, paths, snippets, and file URLs", async () => {
	const requests: string[] = [];
	globalThis.fetch = (async (input) => {
		requests.push(String(input));
		return jsonResponse(grepFixture);
	}) as typeof fetch;

	const result = await searchCode({ query: "autograd Variable", limit: 5 });
	const details = result as {
		source: string;
		totalCount: number;
		returned: number;
		results: Array<{ repo: string; path: string; branch?: string; snippet?: string; url?: string }>;
	};

	assert.equal(details.source, "grep_app");
	assert.equal(details.totalCount, 2);
	assert.equal(details.returned, 2);
	assert.equal(details.results[0]?.repo, "pytorch/pytorch");
	assert.equal(details.results[0]?.snippet, "class Variable:");
	assert.equal(details.results[0]?.url, "https://github.com/pytorch/pytorch/blob/main/torch/autograd/__init__.py");
	assert.equal(details.results[1]?.url, "https://github.com/jax-ml/jax/tree/HEAD/jax/_src/api.py");
	assert.match(new URL(requests[0]!).hostname, /grep\.app/);
});

test("code search rejects empty queries and names rate limits", async () => {
	await assert.rejects(searchCode({ query: "   " }), /non-empty query/);

	globalThis.fetch = (async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;
	await assert.rejects(searchCode({ query: "x" }), /rate-limited.*lang:.*path:.*repo:/);
});

test("code search tool registers with query guidance", async () => {
	const tools = new Map<string, { description: string; name: string; promptGuidelines: string[]; promptSnippet: string }>();
	registerCodeSearchTool({
		registerTool(tool: never) { tools.set((tool as { name: string }).name, tool as never); },
	} as unknown as ExtensionAPI);
	const tool = tools.get("hypatia_code_search")!;
	assert.match(tool.description, /grep\.app/);
	assert.match(tool.promptGuidelines.join("\n"), /paper-code audits/);
});

test("context7 MCP registers only when explicitly enabled", () => {
	const previous = process.env.HYPATIA_CONTEXT7;
	const registered: Array<{ name: string; config: unknown }> = [];
	const pi = {
		registerMcpServer: (name: string, config: unknown) => { registered.push({ name, config }); },
	} as unknown as ExtensionAPI;
	try {
		delete process.env.HYPATIA_CONTEXT7;
		registerContext7Mcp(pi);
		assert.equal(registered.length, 0);

		process.env.HYPATIA_CONTEXT7 = "1";
		registerContext7Mcp(pi);
		assert.equal(registered.length, 1);
		assert.equal(registered[0]?.name, "context7");
		assert.deepEqual((registered[0]?.config as { args: string[] }).args, ["-y", "@upstash/context7-mcp"]);
	} finally {
		if (previous === undefined) delete process.env.HYPATIA_CONTEXT7;
		else process.env.HYPATIA_CONTEXT7 = previous;
	}
});

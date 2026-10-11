import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { registerScienceDatabaseTools } from "../extensions/research-tools/science-databases.js";

type Tool = {
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
	name: string;
};

const originalFetch = globalThis.fetch;
const names = [
	"HYPATIA_LAYA_ENABLED",
	"HYPATIA_LAYA_URL",
	"HYPATIA_LAYA_TIMEOUT_MS",
	"HYPATIA_LAYA_CONCURRENCY",
	"LAYA_API_KEY",
] as const;
const originalEnv = new Map(names.map((name) => [name, process.env[name]]));

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const name of names) {
		const value = originalEnv.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
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

test("science database tool applies opt-in Laya scores before returning topical search results", async () => {
	process.env.HYPATIA_LAYA_ENABLED = "1";
	process.env.HYPATIA_LAYA_URL = "http://127.0.0.1:8000";
	delete process.env.HYPATIA_LAYA_TIMEOUT_MS;
	delete process.env.HYPATIA_LAYA_CONCURRENCY;
	delete process.env.LAYA_API_KEY;

	const paths: string[] = [];
	let healthCalls = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		paths.push(`${url.hostname}${url.pathname}`);
		if (url.hostname === "api.semanticscholar.org") {
			return jsonResponse({
				total: 2,
				data: [
					{ paperId: "original-first", title: "Original first", abstract: "First abstract." },
					{ paperId: "laya-first", title: "Laya first", abstract: "Second abstract." },
				],
			});
		}
		if (url.hostname === "127.0.0.1" && url.pathname === "/health") {
			healthCalls += 1;
			if (healthCalls === 1) return jsonResponse({ status: "ok" });
			return jsonResponse({
				status: "ok",
				revisions: { english: "revision-integration-test" },
				checkpoint_devices: { english: "cpu" },
			});
		}
		if (url.hostname === "127.0.0.1" && url.pathname === "/v1/systemone") {
			const body = JSON.parse(String(init?.body)) as { state: string };
			const layaFirst = body.state.includes("Paper title: Laya first");
			const score = layaFirst ? 0.95 : 0.15;
			return jsonResponse({
				answers: { relevance: { choice: layaFirst ? "A" : "B", probabilities: { A: score, B: 1 - score } } },
				usage: { truncated: false },
			});
		}
		throw new Error(`unexpected URL ${url.toString()}`);
	};

	const tool = registerTools().get("hypatia_science_database_search");
	assert.ok(tool);
	const result = await tool.execute("call-laya", {
		source: "semanticscholar",
		query: "mechanistic interpretability sparse autoencoders",
		limit: 2,
	});
	const details = result.details as {
		layaStatus: { state: string; revision: string };
		results: Array<{ layaOriginalRank: number; paperId: string; layaScore: number }>;
	};

	assert.equal(details.layaStatus.state, "reranked");
	assert.equal(details.layaStatus.revision, "revision-integration-test");
	assert.equal(healthCalls, 2);
	assert.deepEqual(details.results.map((row) => [row.paperId, row.layaOriginalRank, row.layaScore]), [
		["laya-first", 2, 0.95],
		["original-first", 1, 0.15],
	]);
	assert.ok(paths.includes("127.0.0.1/health"));
	assert.equal(paths.filter((path) => path === "127.0.0.1/v1/systemone").length, 2);
	assert.match(result.content[0]?.text ?? "", /"state": "reranked"/u);
});

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

test("science database search preserves source order when Laya is enabled", async () => {
	process.env.HYPATIA_LAYA_ENABLED = "1";
	process.env.HYPATIA_LAYA_URL = "http://127.0.0.1:8000";
	delete process.env.HYPATIA_LAYA_TIMEOUT_MS;
	delete process.env.HYPATIA_LAYA_CONCURRENCY;
	delete process.env.LAYA_API_KEY;

	let layaCalls = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "api.semanticscholar.org") {
			return jsonResponse({
				total: 2,
				data: [
					{ paperId: "original-first", title: "Original first", abstract: "First abstract." },
					{ paperId: "laya-first", title: "Laya first", abstract: "Second abstract." },
				],
			});
		}
		if (url.hostname === "127.0.0.1") layaCalls += 1;
		throw new Error(`unexpected URL ${url.toString()}`);
	};

	const tool = registerTools().get("hypatia_science_database_search");
	assert.ok(tool);
	const result = await tool.execute("call-laya", {
		source: "semanticscholar",
		query: "mechanistic interpretability sparse autoencoders",
		limit: 2,
	});
	const details = result.details as { results: Array<{ paperId: string }> };

	assert.deepEqual(details.results.map((row) => row.paperId), ["original-first", "laya-first"]);
	assert.equal("layaStatus" in details, false);
	assert.equal(layaCalls, 0);
});

test("explicit Laya advisory returns a suggested order without replacing source order", async () => {
	process.env.HYPATIA_LAYA_ENABLED = "1";
	process.env.HYPATIA_LAYA_URL = "http://127.0.0.1:8000";
	delete process.env.HYPATIA_LAYA_TIMEOUT_MS;
	delete process.env.HYPATIA_LAYA_CONCURRENCY;
	delete process.env.LAYA_API_KEY;

	let healthCalls = 0;
	let scoreCalls = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "api.semanticscholar.org") {
			return jsonResponse({
				total: 2,
				data: [
					{ paperId: "original-first", title: "Original first", abstract: "First abstract." },
					{ paperId: "laya-first", title: "Laya first", abstract: "Second abstract." },
				],
			});
		}
		if (url.pathname === "/health") {
			healthCalls += 1;
			return healthCalls === 1
				? jsonResponse({ status: "ok" })
				: jsonResponse({
						status: "ok",
						revisions: { english: "revision-integration-test" },
						checkpoint_devices: { english: "cpu" },
					});
		}
		if (url.pathname === "/v1/systemone") {
			scoreCalls += 1;
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

	const tools = registerTools();
	const searchTool = tools.get("hypatia_science_database_search");
	const advisoryTool = tools.get("hypatia_laya_advisory");
	assert.ok(searchTool);
	assert.ok(advisoryTool);
	const search = await searchTool.execute("call-search", {
		source: "semanticscholar",
		query: "mechanistic interpretability sparse autoencoders",
		limit: 2,
	});
	const searchDetails = search.details as {
		results: Array<{ abstract: string; paperId: string; title: string }>;
	};
	assert.deepEqual(searchDetails.results.map((row) => row.paperId), ["original-first", "laya-first"]);
	assert.equal(healthCalls, 0);
	assert.equal(scoreCalls, 0);

	const advisory = await advisoryTool.execute("call-advisory", {
		source: "semanticscholar",
		query: "mechanistic interpretability sparse autoencoders",
		candidates: searchDetails.results.map((row) => ({
			candidateId: row.paperId,
			title: row.title,
			abstract: row.abstract,
		})),
	});
	const advisoryDetails = advisory.details as {
		layaStatus: { state: string; revision: string };
		layaSuggestedOrder: Array<{ candidateId: string; layaScore: number; layaOriginalRank: number }>;
		results: Array<{ candidateId: string }>;
	};

	assert.equal(advisoryDetails.layaStatus.state, "advisory");
	assert.equal(advisoryDetails.layaStatus.revision, "revision-integration-test");
	assert.deepEqual(advisoryDetails.results.map((row) => row.candidateId), ["original-first", "laya-first"]);
	assert.deepEqual(advisoryDetails.layaSuggestedOrder.map((row) => [row.candidateId, row.layaOriginalRank, row.layaScore]), [
		["laya-first", 2, 0.95],
		["original-first", 1, 0.15],
	]);
	assert.equal(healthCalls, 2);
	assert.equal(scoreCalls, 2);
});

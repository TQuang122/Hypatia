import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { registerScienceDatabaseTools } from "../extensions/research-tools/science-databases.js";

type Tool = {
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
	name: string;
};

const originalFetch = globalThis.fetch;
const names = [
	"HYPATIA_KEV_ENABLED",
	"HYPATIA_KEV_URL",
	"HYPATIA_KEV_TIMEOUT_MS",
	"HYPATIA_KEV_CONCURRENCY",
	"KEV_API_KEY",
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

test("science database search preserves source order when Kev is enabled", async () => {
	process.env.HYPATIA_KEV_ENABLED = "1";
	process.env.HYPATIA_KEV_URL = "http://127.0.0.1:8008";
	delete process.env.HYPATIA_KEV_TIMEOUT_MS;
	delete process.env.HYPATIA_KEV_CONCURRENCY;
	delete process.env.KEV_API_KEY;

	let kevCalls = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "api.semanticscholar.org") {
			return jsonResponse({
				total: 2,
				data: [
					{ paperId: "original-first", title: "Original first", abstract: "First abstract." },
					{ paperId: "kev-first", title: "Kev first", abstract: "Second abstract." },
				],
			});
		}
		if (url.hostname === "127.0.0.1") kevCalls += 1;
		throw new Error(`unexpected URL ${url.toString()}`);
	};

	const tool = registerTools().get("hypatia_science_database_search");
	assert.ok(tool);
	const result = await tool.execute("call-kev", {
		source: "semanticscholar",
		query: "mechanistic interpretability sparse autoencoders",
		limit: 2,
	});
	const details = result.details as { results: Array<{ paperId: string }> };

	assert.deepEqual(details.results.map((row) => row.paperId), ["original-first", "kev-first"]);
	assert.equal("kevStatus" in details, false);
	assert.equal(kevCalls, 0);
});

test("explicit Kev advisory returns a suggested order without replacing source order", async () => {
	process.env.HYPATIA_KEV_ENABLED = "1";
	process.env.HYPATIA_KEV_URL = "http://127.0.0.1:8008";
	delete process.env.HYPATIA_KEV_TIMEOUT_MS;
	delete process.env.HYPATIA_KEV_CONCURRENCY;
	delete process.env.KEV_API_KEY;

	let modelCalls = 0;
	let scoreCalls = 0;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "api.semanticscholar.org") {
			return jsonResponse({
				total: 2,
				data: [
					{ paperId: "original-first", title: "Original first", abstract: "First abstract." },
					{ paperId: "kev-first", title: "Kev first", abstract: "Second abstract." },
				],
			});
		}
		if (url.pathname === "/v1/models") {
			modelCalls += 1;
			return jsonResponse({
				models: [{ name: "kev-latest", run: "jaredpalmer/kev-4b", device: "cpu", truncate_states: false }],
			});
		}
		if (url.pathname === "/v1/systemone") {
			scoreCalls += 1;
			const body = JSON.parse(String(init?.body)) as { state: string };
			const kevFirst = body.state.includes("Paper title: Kev first");
			const score = kevFirst ? 0.95 : 0.15;
			return jsonResponse({
				answers: { relevance: { choice: kevFirst ? "A" : "B", probabilities: { A: score, B: 1 - score } } },
				truncated: false,
			});
		}
		throw new Error(`unexpected URL ${url.toString()}`);
	};

	const tools = registerTools();
	const searchTool = tools.get("hypatia_science_database_search");
	const advisoryTool = tools.get("hypatia_kev_advisory");
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
	assert.deepEqual(searchDetails.results.map((row) => row.paperId), ["original-first", "kev-first"]);
	assert.equal(modelCalls, 0);
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
		kevStatus: { state: string; checkpoint: string };
		kevSuggestedOrder: Array<{ candidateId: string; kevScore: number; kevOriginalRank: number }>;
		results: Array<{ candidateId: string }>;
	};

	assert.equal(advisoryDetails.kevStatus.state, "advisory");
	assert.equal(advisoryDetails.kevStatus.checkpoint, "jaredpalmer/kev-4b");
	assert.deepEqual(advisoryDetails.results.map((row) => row.candidateId), ["original-first", "kev-first"]);
	assert.deepEqual(advisoryDetails.kevSuggestedOrder.map((row) => [row.candidateId, row.kevOriginalRank, row.kevScore]), [
		["kev-first", 2, 0.95],
		["original-first", 1, 0.15],
	]);
	assert.equal(modelCalls, 2);
	assert.equal(scoreCalls, 2);
});

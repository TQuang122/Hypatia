import assert from "node:assert/strict";
import test from "node:test";

import { rerankScienceDatabaseResults } from "../extensions/research-tools/kev-advisory.js";

type Candidate = {
	abstract?: string;
	paperId: string;
	title: string;
};

function searchResult(candidates: Candidate[]): Record<string, unknown> {
	return { source: "semanticscholar", returned: candidates.length, results: candidates };
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function modelsResponse(model = "kev-latest", run = "jaredpalmer/kev-4b", device = "cpu", truncateStates = false): Response {
	return response({
		models: [{ name: model, run, device, truncate_states: truncateStates }],
	});
}

function scoreResponse(score: number, truncated = false): Response {
	return response({
		answers: { relevance: { choice: score >= 0.5 ? "A" : "B", probabilities: { A: score, B: 1 - score } } },
		truncated,
	});
}

const topicParams = { source: "semanticscholar", query: "mechanistic interpretability sparse autoencoders" };
const enabledEnv = {
	HYPATIA_KEV_ENABLED: "1",
	HYPATIA_KEV_URL: "http://127.0.0.1:8008",
	HYPATIA_KEV_TIMEOUT_MS: "2000",
	HYPATIA_KEV_CONCURRENCY: "2",
	KEV_API_KEY: "local-test-key",
};

test("Kev advisory reads System One model metadata and reports top-level truncation", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First paper", abstract: "First abstract." },
		{ paperId: "second", title: "Second paper", abstract: "Second abstract." },
	]);
	const paths: string[] = [];
	const result = await rerankScienceDatabaseResults(topicParams, original, {
		HYPATIA_KEV_ENABLED: "1",
		HYPATIA_KEV_URL: "http://127.0.0.1:8008",
	}, async (input, init) => {
		const url = new URL(String(input));
		paths.push(url.pathname);
		if (url.pathname === "/v1/models") {
			return response({
				models: [{
					name: "kev-latest",
					run: "jaredpalmer/kev-4b",
					device: "mps",
					truncate_states: true,
				}],
			});
		}
		assert.equal(url.pathname, "/v1/systemone");
		const body = JSON.parse(String(init?.body)) as { state: string };
		const first = body.state.includes("Paper title: First paper");
		const score = first ? 0.2 : 0.9;
		return response({
			answers: { relevance: { choice: first ? "A" : "B", probabilities: { A: score, B: 1 - score } } },
			truncated: first,
		});
	});
	const details = result as {
		kevStatus?: { state: string; checkpoint: string; device: string };
		results?: Array<Record<string, unknown>>;
	};

	assert.equal(details.kevStatus?.state, "advisory");
	assert.equal(details.kevStatus?.checkpoint, "jaredpalmer/kev-4b");
	assert.equal(details.kevStatus?.device, "mps");
	assert.deepEqual(details.results?.map((row) => [row.paperId, row.kevRankDelta, row.kevTruncated]), [
		["first", -1, true],
		["second", 1, false],
	]);
	assert.deepEqual(paths, ["/v1/models", "/v1/systemone", "/v1/systemone", "/v1/models"]);
});

test("Kev accepts omitted truncation only when the server disables truncation", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First paper", abstract: "First abstract." },
		{ paperId: "second", title: "Second paper", abstract: "Second abstract." },
	]);
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		if (new URL(String(input)).pathname === "/v1/models") return modelsResponse();
		return response({
			answers: { relevance: { choice: "A", probabilities: { A: 0.8, B: 0.2 } } },
		});
	});
	const details = result as {
		kevStatus: { state: string };
		results: Array<Record<string, unknown>>;
	};

	assert.equal(details.kevStatus.state, "advisory");
	assert.deepEqual(details.results.map((row) => row.kevTruncated), [false, false]);
});

test("Kev rejects missing or invalid truncation status when truncation is enabled", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First paper", abstract: "First abstract." },
		{ paperId: "second", title: "Second paper", abstract: "Second abstract." },
	]);
	for (const malformedStatus of [undefined, "false"]) {
		const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
			if (new URL(String(input)).pathname === "/v1/models") return modelsResponse("kev-latest", "jaredpalmer/kev-4b", "cpu", true);
			const body: Record<string, unknown> = {
				answers: { relevance: { choice: "A", probabilities: { A: 0.8, B: 0.2 } } },
			};
			if (malformedStatus !== undefined) body.truncated = malformedStatus;
			return response(body);
		});
		const details = result as {
			kevStatus: { state: string; message: string };
			results: Array<Record<string, unknown>>;
		};

		assert.equal(details.kevStatus.state, "unavailable");
		assert.match(details.kevStatus.message, /truncation/u);
		assert.deepEqual(details.results, original.results);
		assert.equal("kevSuggestedOrder" in details, false);
	}
});

test("Kev stays disabled by default and leaves source order unchanged", async () => {
	const original = searchResult([
		{ paperId: "second", title: "Second paper", abstract: "Second abstract." },
		{ paperId: "first", title: "First paper", abstract: "First abstract." },
	]);
	let calls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, {}, async () => {
		calls += 1;
		throw new Error("Kev must not be contacted when disabled.");
	});
	const details = result as { kevStatus: { state: string }; results: unknown[] };

	assert.equal(calls, 0);
	assert.equal(details.kevStatus.state, "not_applicable");
	assert.deepEqual(details.results, original.results);
});

test("Kev returns a suggested order without changing source order", async () => {
	const original = searchResult([
		{ paperId: "lower", title: "Lower score", abstract: "Abstract one." },
		{ paperId: "tie-first", title: "First tied score", abstract: "Abstract two." },
		{ paperId: "tie-second", title: "Second tied score", abstract: "Abstract three." },
	]);
	const posts: Array<{ state: string; headers: HeadersInit }> = [];
	const scores = new Map([["Lower score", 0.2], ["First tied score", 0.8], ["Second tied score", 0.8]]);
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/models") return modelsResponse();
		assert.equal(url.pathname, "/v1/systemone");
		const body = JSON.parse(String(init?.body)) as { state: string };
		posts.push({ state: body.state, headers: init?.headers ?? {} });
		const title = [...scores.keys()].find((value) => body.state.includes(`Paper title: ${value}`));
		assert.ok(title);
		return scoreResponse(scores.get(title)!);
	});

	const details = result as {
		kevStatus: { state: string; checkpoint: string; device: string; abstractMissingCount: number };
		results: Array<Record<string, unknown>>;
		kevSuggestedOrder: Array<Record<string, unknown>>;
	};
	assert.equal(details.kevStatus.state, "advisory");
	assert.equal(details.kevStatus.checkpoint, "jaredpalmer/kev-4b");
	assert.equal(details.kevStatus.device, "cpu");
	assert.equal(details.kevStatus.abstractMissingCount, 0);
	assert.deepEqual(details.results.map((row) => [
		row.paperId,
		row.kevOriginalRank,
		row.kevSuggestedRank,
		row.kevRankDelta,
	]), [
		["lower", 1, 3, -2],
		["tie-first", 2, 1, 1],
		["tie-second", 3, 2, 1],
	]);
	assert.deepEqual(details.results.map((row) => row.kevScore), [0.2, 0.8, 0.8]);
	assert.deepEqual(details.kevSuggestedOrder.map((row) => [
		row.candidateId,
		row.kevOriginalRank,
		row.kevSuggestedRank,
		row.kevRankDelta,
	]), [
		["tie-first", 2, 1, 1],
		["tie-second", 3, 2, 1],
		["lower", 1, 3, -2],
	]);
	assert.ok(details.kevSuggestedOrder.every((row) => !("abstract" in row)));
	assert.ok(posts.every(({ state }) => state.includes("Research question:\nmechanistic interpretability sparse autoencoders")));
	assert.ok(posts.every(({ headers }) => new Headers(headers).get("authorization") === "Bearer local-test-key"));
});

test("Kev advisory can target a configured model alias", async () => {
	const model = "hypatia-relevance";
	const original = searchResult([
		{ paperId: "candidate-1", title: "First paper", abstract: "Evidence." },
		{ paperId: "candidate-2", title: "Second paper", abstract: "More evidence." },
	]);
	const result = await rerankScienceDatabaseResults(
		topicParams,
		original,
		{ ...enabledEnv, HYPATIA_KEV_MODEL: model },
		async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/models") {
				return modelsResponse(model, "local/kev-custom", "mps");
			}
			const body = JSON.parse(String(init?.body)) as { model: string };
			assert.equal(body.model, model);
			return scoreResponse(0.8);
		},
	);

	const details = result as {
		kevStatus: { state: string; checkpoint: string; device: string };
	};
	assert.equal(details.kevStatus.state, "advisory");
	assert.equal(details.kevStatus.checkpoint, "local/kev-custom");
	assert.equal(details.kevStatus.device, "mps");
});

test("exact identifiers and database lookup modes do not call Kev", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "First abstract." },
		{ paperId: "second", title: "Second", abstract: "Second abstract." },
	]);
	for (const { params, mode } of [
		{ params: { source: "semanticscholar", query: "10.1000/example" }, mode: undefined },
		{ params: { source: "openalex", query: "openalex_citations:W123" }, mode: "citations" },
		{ params: { source: "openalex", query: "citations W123" }, mode: "citations" },
		{ params: { source: "openalex", query: "references W123" }, mode: "references" },
		{ params: { source: "pubmed", query: "35486828,35486829" }, mode: "metadata" },
		{ params: { source: "europepmc", query: "EXT_ID:123456" }, mode: undefined },
		{ params: { source: "europepmc", query: "fulltext PMC123 PMC456" }, mode: "fulltext" },
		{ params: { source: "europepmc", query: "jats PMC123 PMC456" }, mode: "fulltext" },
		{ params: { source: "europepmc", query: "sections pmid:123 456" }, mode: "fulltext" },
	]) {
		let calls = 0;
		const result = await rerankScienceDatabaseResults(params, { ...original, mode }, enabledEnv, async () => {
			calls += 1;
			throw new Error("ineligible queries must not contact Kev.");
		});
		assert.equal(calls, 0);
		assert.deepEqual((result as { results: unknown[] }).results, original.results);
		assert.equal((result as { kevStatus: { state: string } }).kevStatus.state, "not_applicable");
	}
});

test("OpenAlex topical search modes remain eligible for Kev", async () => {
	for (const { query, mode } of [
		{ query: "single-cell atlas annotation", mode: "work-search" },
		{ query: "semantic: spatial transcriptomics", mode: "work-semantic-search" },
		{ query: "openalex_search_works:CRISPR", mode: "openalex_search_works" },
	]) {
		const original = {
			...searchResult([
				{ paperId: "first", title: "First", abstract: "First abstract." },
				{ paperId: "second", title: "Second", abstract: "Second abstract." },
			]),
			source: "openalex",
			mode,
		};
		const result = await rerankScienceDatabaseResults(
			{ source: "openalex", query },
			original,
			enabledEnv,
			async (input) => new URL(String(input)).pathname === "/v1/models" ? modelsResponse() : scoreResponse(0.8),
		);

		assert.equal((result as { kevStatus: { state: string } }).kevStatus.state, "advisory");
	}
});

test("missing abstracts are scored title-only and reported", async () => {
	const original = searchResult([
		{ paperId: "no-abstract", title: "Title only" },
		{ paperId: "with-abstract", title: "With abstract", abstract: "Abstract text." },
	]);
	const states: string[] = [];
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input, init) => {
		if (new URL(String(input)).pathname === "/v1/models") return modelsResponse();
		states.push((JSON.parse(String(init?.body)) as { state: string }).state);
		return scoreResponse(0.9);
	});
	const details = result as { kevStatus: { abstractMissingCount: number }; results: Array<Record<string, unknown>> };

	assert.equal(details.kevStatus.abstractMissingCount, 1);
	assert.equal(details.results.find((row) => row.paperId === "no-abstract")?.kevAbstractMissing, true);
	assert.ok(states.some((state) => state.includes("Paper title: Title only")));
	assert.ok(states.some((state) => state.includes("Abstract: not available")));
});

test("service failures preserve every result in the original order with a visible status", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "First abstract." },
		{ paperId: "second", title: "Second", abstract: "Second abstract." },
	]);
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		if (new URL(String(input)).pathname === "/v1/models") return modelsResponse();
		throw new Error("connection refused");
	});
	const details = result as { kevStatus: { state: string; message: string }; results: Array<{ paperId: string }> };

	assert.equal(details.kevStatus.state, "unavailable");
	assert.match(details.kevStatus.message, /original order was retained/u);
	assert.deepEqual(details.results.map((row) => row.paperId), ["first", "second"]);
});

test("remote service URLs are rejected without contacting the configured host", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "Abstract one." },
		{ paperId: "second", title: "Second", abstract: "Abstract two." },
	]);
	let calls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, {
		...enabledEnv,
		HYPATIA_KEV_URL: "https://example.com",
	}, async () => {
		calls += 1;
		throw new Error("remote URL must be rejected before fetch.");
	});
	const details = result as { kevStatus: { state: string; message: string } };

	assert.equal(calls, 0);
	assert.equal(details.kevStatus.state, "unavailable");
	assert.match(details.kevStatus.message, /loopback/u);
});

test("candidate inference respects the configured concurrency bound", async () => {
	const original = searchResult(Array.from({ length: 5 }, (_, index) => ({
		paperId: `paper-${index}`,
		title: `Paper ${index}`,
		abstract: `Abstract ${index}.`,
	})));
	const waiters: Array<() => void> = [];
	let active = 0;
	let peak = 0;
	let scoreCalls = 0;
	const resultPromise = rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		if (new URL(String(input)).pathname === "/v1/models") return modelsResponse();
		active += 1;
		scoreCalls += 1;
		peak = Math.max(peak, active);
		return await new Promise<Response>((resolve) => {
			waiters.push(() => {
				active -= 1;
				resolve(scoreResponse(0.6));
			});
			if (waiters.length >= 2 || scoreCalls === 5) {
				for (const release of waiters.splice(0)) release();
			}
		});
	});
	const result = await resultPromise;

	assert.equal((result as { kevStatus: { state: string } }).kevStatus.state, "advisory");
	assert.equal(peak, 2);
});

test("Kev model metadata is checked before and after inference", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "Abstract one." },
		{ paperId: "second", title: "Second", abstract: "Abstract two." },
	]);
	let modelCalls = 0;
	let scoreCalls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/models") {
			modelCalls += 1;
			return modelsResponse();
		}
		scoreCalls += 1;
		return scoreResponse(0.75);
	});

	assert.equal((result as { kevStatus: { state: string } }).kevStatus.state, "advisory");
	assert.equal(modelCalls, 2);
	assert.equal(scoreCalls, 2);
});

test("changed final Kev checkpoint preserves source order after inference", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "First abstract." },
		{ paperId: "second", title: "Second", abstract: "Second abstract." },
	]);
	let modelCalls = 0;
	let scoreCalls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/models") {
			modelCalls += 1;
			return modelsResponse("kev-latest", modelCalls === 1 ? "jaredpalmer/kev-4b" : "jaredpalmer/kev-9b");
		}
		scoreCalls += 1;
		return scoreResponse(0.95);
	});
	const details = result as {
		kevStatus: { state: string; message: string };
		results: Array<Record<string, unknown>>;
	};

	assert.equal(modelCalls, 2);
	assert.equal(scoreCalls, 2);
	assert.equal(details.kevStatus.state, "unavailable");
	assert.match(details.kevStatus.message, /original order was retained/u);
	assert.deepEqual(details.results, original.results);
});

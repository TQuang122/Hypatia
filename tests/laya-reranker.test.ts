import assert from "node:assert/strict";
import test from "node:test";

import { rerankScienceDatabaseResults } from "../extensions/research-tools/laya-reranker.js";

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

function healthResponse(): Response {
	return response({
		status: "ok",
		revisions: { english: "revision-test" },
		checkpoint_devices: { english: "cpu" },
	});
}

function scoreResponse(score: number, truncated = false): Response {
	return response({
		answers: { relevance: { choice: score >= 0.5 ? "A" : "B", probabilities: { A: score, B: 1 - score } } },
		usage: { truncated },
	});
}

const topicParams = { source: "semanticscholar", query: "mechanistic interpretability sparse autoencoders" };
const enabledEnv = {
	HYPATIA_LAYA_ENABLED: "1",
	HYPATIA_LAYA_URL: "http://127.0.0.1:8000",
	HYPATIA_LAYA_TIMEOUT_MS: "2000",
	HYPATIA_LAYA_CONCURRENCY: "2",
	LAYA_API_KEY: "local-test-key",
};

test("Laya stays disabled by default and leaves source order unchanged", async () => {
	const original = searchResult([
		{ paperId: "second", title: "Second paper", abstract: "Second abstract." },
		{ paperId: "first", title: "First paper", abstract: "First abstract." },
	]);
	let calls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, {}, async () => {
		calls += 1;
		throw new Error("Laya must not be contacted when disabled.");
	});
	const details = result as { layaStatus: { state: string }; results: unknown[] };

	assert.equal(calls, 0);
	assert.equal(details.layaStatus.state, "not_applicable");
	assert.deepEqual(details.results, original.results);
});

test("Laya returns a suggested order without changing source order", async () => {
	const original = searchResult([
		{ paperId: "lower", title: "Lower score", abstract: "Abstract one." },
		{ paperId: "tie-first", title: "First tied score", abstract: "Abstract two." },
		{ paperId: "tie-second", title: "Second tied score", abstract: "Abstract three." },
	]);
	const posts: Array<{ state: string; headers: HeadersInit }> = [];
	const scores = new Map([["Lower score", 0.2], ["First tied score", 0.8], ["Second tied score", 0.8]]);
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/health") return healthResponse();
		assert.equal(url.pathname, "/v1/systemone");
		const body = JSON.parse(String(init?.body)) as { state: string };
		posts.push({ state: body.state, headers: init?.headers ?? {} });
		const title = [...scores.keys()].find((value) => body.state.includes(`Paper title: ${value}`));
		assert.ok(title);
		return scoreResponse(scores.get(title)!);
	});

	const details = result as {
		layaStatus: { state: string; revision: string; device: string; abstractMissingCount: number };
		results: Array<Record<string, unknown>>;
		layaSuggestedOrder: Array<Record<string, unknown>>;
	};
	assert.equal(details.layaStatus.state, "advisory");
	assert.equal(details.layaStatus.revision, "revision-test");
	assert.equal(details.layaStatus.device, "cpu");
	assert.equal(details.layaStatus.abstractMissingCount, 0);
	assert.deepEqual(details.results.map((row) => [row.paperId, row.layaOriginalRank]), [
		["lower", 1],
		["tie-first", 2],
		["tie-second", 3],
	]);
	assert.deepEqual(details.results.map((row) => row.layaScore), [0.2, 0.8, 0.8]);
	assert.deepEqual(details.layaSuggestedOrder.map((row) => [row.candidateId, row.layaOriginalRank]), [
		["tie-first", 2],
		["tie-second", 3],
		["lower", 1],
	]);
	assert.ok(details.layaSuggestedOrder.every((row) => !("abstract" in row)));
	assert.ok(posts.every(({ state }) => state.includes("Research question:\nmechanistic interpretability sparse autoencoders")));
	assert.ok(posts.every(({ headers }) => new Headers(headers).get("authorization") === "Bearer local-test-key"));
});

test("Laya advisory can target a registered fine-tuned model alias", async () => {
	const model = "hypatia-relevance";
	const original = searchResult([
		{ paperId: "candidate-1", title: "First paper", abstract: "Evidence." },
		{ paperId: "candidate-2", title: "Second paper", abstract: "More evidence." },
	]);
	const result = await rerankScienceDatabaseResults(
		topicParams,
		original,
		{ ...enabledEnv, HYPATIA_LAYA_MODEL: model },
		async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === "/health") {
				return response({
					status: "ok",
					revisions: { [model]: "fine-tuned-revision" },
					checkpoint_devices: { [model]: "mps" },
				});
			}
			const body = JSON.parse(String(init?.body)) as { model: string };
			assert.equal(body.model, model);
			return scoreResponse(0.8);
		},
	);

	const details = result as {
		layaStatus: { state: string; revision: string; device: string };
	};
	assert.equal(details.layaStatus.state, "advisory");
	assert.equal(details.layaStatus.revision, "fine-tuned-revision");
	assert.equal(details.layaStatus.device, "mps");
});

test("exact identifiers and database lookup modes do not call Laya", async () => {
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
		{ params: { source: "europepmc", query: "fulltext PMC123 PMC456" }, mode: "fulltext" },
		{ params: { source: "europepmc", query: "jats PMC123 PMC456" }, mode: "fulltext" },
		{ params: { source: "europepmc", query: "sections pmid:123 456" }, mode: "fulltext" },
	]) {
		let calls = 0;
		const result = await rerankScienceDatabaseResults(params, { ...original, mode }, enabledEnv, async () => {
			calls += 1;
			throw new Error("ineligible queries must not contact Laya.");
		});
		assert.equal(calls, 0);
		assert.deepEqual((result as { results: unknown[] }).results, original.results);
		assert.equal((result as { layaStatus: { state: string } }).layaStatus.state, "not_applicable");
	}
});

test("OpenAlex topical search modes remain eligible for Laya", async () => {
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
			async (input) => new URL(String(input)).pathname === "/health" ? healthResponse() : scoreResponse(0.8),
		);

		assert.equal((result as { layaStatus: { state: string } }).layaStatus.state, "advisory");
	}
});

test("missing abstracts are scored title-only and reported", async () => {
	const original = searchResult([
		{ paperId: "no-abstract", title: "Title only" },
		{ paperId: "with-abstract", title: "With abstract", abstract: "Abstract text." },
	]);
	const states: string[] = [];
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input, init) => {
		if (new URL(String(input)).pathname === "/health") return healthResponse();
		states.push((JSON.parse(String(init?.body)) as { state: string }).state);
		return scoreResponse(0.9);
	});
	const details = result as { layaStatus: { abstractMissingCount: number }; results: Array<Record<string, unknown>> };

	assert.equal(details.layaStatus.abstractMissingCount, 1);
	assert.equal(details.results.find((row) => row.paperId === "no-abstract")?.layaAbstractMissing, true);
	assert.ok(states.some((state) => state.includes("Paper title: Title only")));
	assert.ok(states.some((state) => state.includes("Abstract: not available")));
});

test("service failures preserve every result in the original order with a visible status", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "First abstract." },
		{ paperId: "second", title: "Second", abstract: "Second abstract." },
	]);
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		if (new URL(String(input)).pathname === "/health") return healthResponse();
		throw new Error("connection refused");
	});
	const details = result as { layaStatus: { state: string; message: string }; results: Array<{ paperId: string }> };

	assert.equal(details.layaStatus.state, "unavailable");
	assert.match(details.layaStatus.message, /original order was retained/u);
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
		HYPATIA_LAYA_URL: "https://example.com",
	}, async () => {
		calls += 1;
		throw new Error("remote URL must be rejected before fetch.");
	});
	const details = result as { layaStatus: { state: string; message: string } };

	assert.equal(calls, 0);
	assert.equal(details.layaStatus.state, "unavailable");
	assert.match(details.layaStatus.message, /loopback/u);
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
		if (new URL(String(input)).pathname === "/health") return healthResponse();
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

	assert.equal((result as { layaStatus: { state: string } }).layaStatus.state, "advisory");
	assert.equal(peak, 2);
});

test("lazy-loaded service is checked for liveness first and revision after inference", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "Abstract one." },
		{ paperId: "second", title: "Second", abstract: "Abstract two." },
	]);
	let healthCalls = 0;
	let scoreCalls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/health") {
			healthCalls += 1;
			return healthCalls === 1 ? response({ status: "ok" }) : healthResponse();
		}
		scoreCalls += 1;
		return scoreResponse(0.75);
	});

	assert.equal((result as { layaStatus: { state: string } }).layaStatus.state, "advisory");
	assert.equal(healthCalls, 2);
	assert.equal(scoreCalls, 2);
});

test("unhealthy final service health preserves source order after inference", async () => {
	const original = searchResult([
		{ paperId: "first", title: "First", abstract: "First abstract." },
		{ paperId: "second", title: "Second", abstract: "Second abstract." },
	]);
	let healthCalls = 0;
	let scoreCalls = 0;
	const result = await rerankScienceDatabaseResults(topicParams, original, enabledEnv, async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/health") {
			healthCalls += 1;
			return healthCalls === 1
				? healthResponse()
				: response({
						status: "error",
						revisions: { english: "revision-test" },
						checkpoint_devices: { english: "cpu" },
					});
		}
		scoreCalls += 1;
		return scoreResponse(0.95);
	});
	const details = result as {
		layaStatus: { state: string; message: string };
		results: Array<Record<string, unknown>>;
	};

	assert.equal(healthCalls, 2);
	assert.equal(scoreCalls, 2);
	assert.equal(details.layaStatus.state, "unavailable");
	assert.match(details.layaStatus.message, /original order was retained/u);
	assert.deepEqual(details.results, original.results);
});

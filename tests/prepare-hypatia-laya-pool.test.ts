import assert from "node:assert/strict";
import test from "node:test";

import { buildCandidatePoolRows, parseQueryManifest, parseQueryOverrides } from "../evals/prepare-hypatia-laya-pool.mjs";

test("candidate pool separates blinded labels from original retrieval ranks", () => {
	const result = buildCandidatePoolRows({
		queryId: "q01",
		query: "test-time compute scaling for LLM reasoning",
		response: {
			source: "semanticscholar",
			results: [
				{
					paperId: "paper-b",
					title: "Paper B",
					abstract: "B abstract",
					doi: "10.1000/b",
					url: "https://example.test/paper-b",
				},
				{
					paperId: "paper-a",
					title: "Paper A",
					abstract: null,
					url: "https://example.test/paper-a",
				},
				{ paperId: "missing-title", title: "", abstract: "No usable title" },
				{ title: "Missing stable identifier", abstract: "Cannot join labels safely" },
			],
		},
	});

	assert.equal(result.skipped, 2);
	assert.deepEqual(result.labels.map((row) => row.candidate_id), ["semanticscholar:paper-a", "semanticscholar:paper-b"]);
	assert.deepEqual(result.rankings.map((row) => [row.candidate_id, row.baseline_rank]), [
		["semanticscholar:paper-b", 1],
		["semanticscholar:paper-a", 2],
	]);
	assert.equal(result.labels[0]?.relevance, null);
	assert.equal(result.labels[0]?.abstract_missing, true);
	assert.equal(result.labels[1]?.relevance, null);
	assert.equal(result.labels[1]?.abstract_missing, false);
	assert.equal(Object.hasOwn(result.labels[0] ?? {}, "retrieval_rank"), false);
	assert.equal(result.labels[1]?.doi, "10.1000/b");
	assert.equal(result.labels[1]?.retrieval_source, "semanticscholar");
});

test("query overrides change retrieval terms without replacing blinded query text", () => {
	const overrides = parseQueryOverrides(
		'{"id":"q07","search_query":"enhancer promoter compatibility human cells Drosophila"}\n',
		new Set(["q07"]),
	);
	assert.equal(overrides.get("q07"), "enhancer promoter compatibility human cells Drosophila");

	const result = buildCandidatePoolRows({
		queryId: "q07",
		query: "Are enhancer and promoter sequences compatible?",
		searchQuery: "enhancer promoter compatibility human cells Drosophila",
		response: {
			source: "openalex",
			results: [{ openalexId: "W123", title: "Enhancer compatibility study", abstract: "Abstract." }],
		},
	});
	assert.equal(result.labels[0]?.query, "Are enhancer and promoter sequences compatible?");
	assert.equal(result.rankings[0]?.search_query, "enhancer promoter compatibility human cells Drosophila");
});

test("query overrides reject duplicate, unknown, and empty search terms", () => {
	assert.throws(() => parseQueryOverrides(
		'{"id":"q07","search_query":"first"}\n{"id":"q07","search_query":"second"}\n',
		new Set(["q07"]),
	), /duplicate query ID q07/);
	assert.throws(() => parseQueryOverrides(
		'{"id":"q08","search_query":"not selected"}\n',
		new Set(["q07"]),
	), /query ID q08 is not in the selected question set/);
	assert.throws(() => parseQueryOverrides(
		'{"id":"q07","search_query":"  "}\n',
		new Set(["q07"]),
	), /search_query must be non-empty/);
});

test("custom held-out manifests preserve only unique question IDs and text", () => {
	const questions = parseQueryManifest(
		'{"id":"holdout-01","question":"new paper-search query"}\n{"id":"holdout-02","question":"another independent query"}\n',
	);
	assert.deepEqual([...questions], [
		["holdout-01", "new paper-search query"],
		["holdout-02", "another independent query"],
	]);
	assert.throws(
		() => parseQueryManifest('{"id":"holdout-01","question":"one"}\n{"id":"holdout-01","question":"duplicate"}\n'),
		/duplicate question ID holdout-01/u,
	);
});

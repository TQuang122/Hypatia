import assert from "node:assert/strict";
import test from "node:test";

import { buildScifactRows, rankBm25Candidates, selectScifactDevClaims } from "../evals/prepare-scifact-laya-pool.mjs";

test("SciFact BM25 ranks title and abstract matches with stable document-ID tie breaks", () => {
	const corpus = [
		{ doc_id: 2, title: "Enhancer promoter", abstract: ["compatibility evidence"] },
		{ doc_id: 1, title: "Enhancer promoter", abstract: ["compatibility evidence"] },
		{ doc_id: 3, title: "Unrelated paper", abstract: ["no matching terms"] },
	];

	const ranked = rankBm25Candidates("enhancer promoter", corpus, 3);

	assert.deepEqual(ranked.map((row) => row.docId), ["1", "2", "3"]);
	assert.ok(ranked[0]!.score > ranked[2]!.score);
});

test("SciFact query sampling is deterministic and excludes prior smoke IDs", () => {
	const claims = Array.from({ length: 40 }, (_, index) => ({
		id: index + 1,
		claim: `Claim ${index + 1}`,
		evidence: { [`${index + 100}`]: [{ label: "SUPPORT" }] },
	}));
	const options = { count: 30, excludedIds: new Set(["1", "3", "5", "13", "36"]), seed: "test-seed" };
	const first = selectScifactDevClaims(claims, options);
	const second = selectScifactDevClaims(claims, options);

	assert.deepEqual(first.map((claim) => claim.id), second.map((claim) => claim.id));
	assert.equal(first.length, 30);
	assert.ok(first.every((claim) => !options.excludedIds.has(String(claim.id))));
});

test("SciFact query sampling excludes claims with no evidence qrels", () => {
	const selected = selectScifactDevClaims([
		{ id: 1, claim: "Claim with no labeled evidence.", evidence: {} },
		{ id: 2, claim: "Claim with evidence.", evidence: { "doc-1": [{ label: "SUPPORT" }] } },
	], { count: 1, excludedIds: new Set(), seed: "empty-qrels" });

	assert.deepEqual(selected.map((claim) => claim.id), [2]);
});

test("SciFact candidate labels use evidence annotations, not cited-document lists", () => {
	const rows = buildScifactRows({
		id: 12,
		claim: "Enhancers activate promoters.",
		evidence: {
			"doc-a": [{ label: "SUPPORT", sentences: [1] }],
			"doc-b": [{ label: "CONTRADICT", sentences: [2] }],
		},
		cited_doc_ids: ["doc-c"],
	}, [
		{ docId: "doc-a", title: "Support", abstract: "Evidence for the claim.", score: 2 },
		{ docId: "doc-c", title: "Cited but unannotated", abstract: "No labeled evidence.", score: 1 },
		{ docId: "doc-b", title: "Contradiction", abstract: "Evidence against the claim.", score: 0.5 },
	]);

	assert.deepEqual(rows.labels.map((row) => [row.candidate_id, row.relevance]), [
		["scifact:doc-a", 1],
		["scifact:doc-c", 0],
		["scifact:doc-b", 1],
	]);
	assert.deepEqual(rows.rankings.map((row) => row.baseline_rank), [1, 2, 3]);
	assert.equal(rows.labels[0]?.query_id, "scifact-dev:12");
});

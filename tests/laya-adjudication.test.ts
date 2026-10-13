import assert from "node:assert/strict";
import test from "node:test";

import { applyLayaAdjudications } from "../evals/apply-laya-adjudications.mjs";

function label(queryId: string, candidateId: string, relevance: number) {
	return {
		query_id: queryId,
		candidate_id: candidateId,
		query: `Question ${queryId}`,
		title: `Paper ${candidateId}`,
		abstract: `Evidence ${candidateId}`,
		relevance,
		abstract_missing: false,
		retrieval_source: "openalex",
	};
}

function adjudication(queryId: string, candidateId: string, relevance: number) {
	return {
		query_id: queryId,
		candidate_id: candidateId,
		adjudicated_relevance: relevance,
		confidence: "high" as const,
		rationale: "The supplied title and abstract closely match the question.",
		adjudicator: "blind_external_ai_reviewer",
	};
}

test("applies adjudicated grades only to double-label disagreements", () => {
	const primary = [
		label("q1", "agreed", 3),
		label("q1", "disputed", 1),
		label("q2", "title-only", 0),
	];
	const duplicate = [
		label("q1", "agreed", 3),
		label("q1", "disputed", 2),
	];

	const result = applyLayaAdjudications(primary, duplicate, [
		adjudication("q1", "disputed", 2),
	]);

	assert.deepEqual(result.rows.map((row) => row.relevance), [3, 2, 0]);
	assert.equal(result.summary.primaryCandidates, 3);
	assert.equal(result.summary.duplicateCandidates, 2);
	assert.equal(result.summary.disagreements, 1);
	assert.equal(result.summary.adjudicatedCandidates, 1);
	assert.equal(result.summary.changedPrimaryGrades, 1);
});

test("rejects unresolved, extra, duplicated, or invalid adjudications", () => {
	const primary = [label("q1", "a", 1)];
	const duplicate = [label("q1", "a", 2)];

	assert.throws(() => applyLayaAdjudications(primary, duplicate, []), /missing adjudication/u);
	assert.throws(() => applyLayaAdjudications(primary, duplicate, [
		adjudication("q2", "unknown", 2),
	]), /not a labeled candidate/u);
	assert.throws(() => applyLayaAdjudications(primary, duplicate, [
		adjudication("q1", "a", 2),
		adjudication("q1", "a", 2),
	]), /duplicate candidate for query_id/u);
	assert.throws(() => applyLayaAdjudications(primary, duplicate, [
		adjudication("q1", "a", 4),
	]), /between 0 and 3/u);
});

test("rejects duplicate-label metadata and decisions for agreed candidates", () => {
	const primary = [label("q1", "a", 1)];
	const mismatchedDuplicate = [{ ...label("q1", "a", 2), title: "Different title" }];

	assert.throws(() => applyLayaAdjudications(primary, mismatchedDuplicate, [
		adjudication("q1", "a", 2),
	]), /metadata differs/u);
	assert.throws(() => applyLayaAdjudications(primary, [label("q1", "a", 1)], [
		adjudication("q1", "a", 2),
	]), /not a disagreement/u);
	assert.throws(() => applyLayaAdjudications(primary, [label("q1", "a", 2)], [
		adjudication("q1", "missing", 2),
	]), /not a labeled candidate/u);
});

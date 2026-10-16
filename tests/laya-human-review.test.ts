import assert from "node:assert/strict";
import test from "node:test";

import { applyLayaHumanReview, type LayaHumanReviewInput } from "../evals/apply-laya-human-review.mjs";

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

function review(queryId: string, candidateId: string, primary: number, duplicate: number, final: number | null) {
	return {
		query_id: queryId,
		candidate_id: candidateId,
		query: `Question ${queryId}`,
		title: `Paper ${candidateId}`,
		primary_relevance: primary,
		double_relevance: duplicate,
		final_relevance: final,
	};
}

function crossedRows() {
	const primary = [];
	const duplicate = [];
	const baseline = [];
	const humanReview = [];
	for (let index = 0; index < 20; index += 1) {
		const queryId = `q${index}`;
		const candidateId = `crossed-${index}`;
		const primaryGrade = index % 2 === 0 ? 1 : 2;
		const duplicateGrade = index % 2 === 0 ? 2 : 1;
		primary.push(label(queryId, candidateId, primaryGrade));
		duplicate.push(label(queryId, candidateId, duplicateGrade));
		baseline.push(label(queryId, candidateId, 3));
		humanReview.push(review(queryId, candidateId, primaryGrade, duplicateGrade, index % 4));
	}
	primary.push(label("q-extra", "same-side", 0));
	duplicate.push(label("q-extra", "same-side", 1));
	baseline.push(label("q-extra", "same-side", 2));
	return { baseline, primary, duplicate, humanReview };
}

test("applies exactly twenty human threshold resolutions to a separate label copy", () => {
	const inputs = crossedRows();
	const originalGrades = inputs.baseline.map((row) => row.relevance);

	const result = applyLayaHumanReview(
		inputs.baseline,
		inputs.primary,
		inputs.duplicate,
		inputs.humanReview,
	);

	assert.deepEqual(result.rows.slice(0, 20).map((row) => row.relevance), inputs.humanReview.map((row) => row.final_relevance));
	assert.equal(result.rows[20].relevance, 2);
	assert.deepEqual(inputs.baseline.map((row) => row.relevance), originalGrades);
	assert.deepEqual(result.rows[0].review_resolution, {
		primary_relevance: 1,
		double_relevance: 2,
		final_relevance: 0,
		reviewer: "user",
	});
	assert.equal(result.summary.resolvedCandidates, 20);
	assert.equal(result.summary.changedBaselineGrades, 15);
	assert.equal(result.summary.unchangedBaselineGrades, 6);
});

test("records assistant adjudication provenance and rationale separately", () => {
	const inputs = crossedRows();
	const assistantReview = inputs.humanReview.map<LayaHumanReviewInput>((row) => ({
		...row,
		reviewer: "assistant",
		confidence: "medium",
		evidence_basis: "title",
		rationale: "The title is topically related, but the abstract is unavailable.",
	}));

	const result = applyLayaHumanReview(
		inputs.baseline,
		inputs.primary,
		inputs.duplicate,
		assistantReview,
		{ reviewer: "assistant" },
	);

	assert.deepEqual(result.rows[0].review_resolution, {
		primary_relevance: 1,
		double_relevance: 2,
		final_relevance: 0,
		reviewer: "assistant",
		confidence: "medium",
		evidence_basis: "title",
		rationale: "The title is topically related, but the abstract is unavailable.",
	});
	assert.equal(result.summary.reviewer, "assistant");
});

test("rejects incomplete, altered, or incomplete-coverage human review sheets", () => {
	const inputs = crossedRows();

	assert.throws(() => applyLayaHumanReview(
		inputs.baseline,
		inputs.primary,
		inputs.duplicate,
		inputs.humanReview.map((row, index) => index === 0 ? { ...row, final_relevance: null } : row),
	), /final_relevance must be an integer/u);

	assert.throws(() => applyLayaHumanReview(
		inputs.baseline,
		inputs.primary,
		inputs.duplicate,
		inputs.humanReview.slice(1),
	), /review sheet must cover all 20 threshold-crossing disagreements/u);

	assert.throws(() => applyLayaHumanReview(
		inputs.baseline,
		inputs.primary,
		inputs.duplicate.map((row, index) => index === 0 ? { ...row, relevance: 1 } : row),
		inputs.humanReview,
	), /threshold-crossing disagreements/u);

	assert.throws(() => applyLayaHumanReview(
		inputs.baseline,
		inputs.primary,
		inputs.duplicate,
		inputs.humanReview.map((row, index) => index === 0 ? { ...row, primary_relevance: 0 } : row),
	), /raw primary grade differs/u);
});

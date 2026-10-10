import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { scoreAstaBenchRows } from "../evals/lanes/astabench.mjs";
import { scoreDeepResearchFactRows } from "../evals/lanes/deepresearch-fact.mjs";
import { scoreSciCoqaRows } from "../evals/lanes/scicoqa.mjs";

test("AstaBench lane averages official ScholarQA scores by model and role", () => {
	const result = scoreAstaBenchRows([
		{
			id: "sample-a",
			model: "provider/model-a",
			role: "researcher",
			scores: { ingredient_recall: 0.8, answer_precision: 0.6, citation_precision: 1, citation_recall: 0.5 },
		},
		{
			id: "sample-b",
			model: "provider/model-a",
			role: "researcher",
			scores: { ingredient_recall: 0.6, answer_precision: 0.8, citation_precision: 0, citation_recall: 1 },
		},
	]);

	assert.equal(result.split, "ScholarQA_CS2_validation");
	assert.deepEqual(result.groups, [{
		model: "provider/model-a",
		role: "researcher",
		samples: 2,
		ingredient_recall: 0.7,
		answer_precision: 0.7,
		citation_precision: 0.5,
		citation_recall: 0.75,
		citation_f1: 1 / 3,
		global_avg: 0.6625,
	}]);
});

test("DeepResearch FACT lane excludes unknown judgments and counts zero-citation reports", () => {
	const result = scoreDeepResearchFactRows([
		{
			id: "report-a",
			model: "provider/model-a",
			role: "verifier",
			citations: [{ id: "[1]" }],
			citations_deduped: {
				"https://example.org/paper": {
					validate_error: null,
					validate_res: [{ result: "supported" }, { result: "unsupported" }, { result: "unknown" }],
				},
				"https://example.org/broken": { validate_error: "fetch failed", validate_res: [] },
			},
		},
		{ id: "report-b", model: "provider/model-a", role: "verifier", citations: [], citations_deduped: {} },
	]);

	assert.deepEqual(result.groups, [{
		model: "provider/model-a",
		role: "verifier",
		reports: 2,
		reports_with_citations: 1,
		supported_claims: 1,
		unsupported_claims: 1,
		unknown_claims: 1,
		validation_errors: 1,
		citation_accuracy: 0.5,
		effective_citations_per_task: 0.5,
		official_style_effective_citations_per_cited_report: 1,
	}]);
});

test("SciCoQA lane counts each real discrepancy once against the pinned 92-item denominator", () => {
	const realIds = Array.from({ length: 92 }, (_, index) => `real-${index}`);
	const result = scoreSciCoqaRows([
		{ model: "provider/model-a", role: "researcher", discrepancy_id: "real-0", origin: "real", code_only: false, eval_type: "eval", answer: "yes" },
		{ model: "provider/model-a", role: "researcher", discrepancy_id: "real-0", origin: "real", code_only: false, eval_type: "eval", answer: "yes" },
		{ model: "provider/model-a", role: "researcher", discrepancy_id: "real-1", origin: "real", code_only: false, eval_type: "eval", answer: "no" },
		{ model: "provider/model-a", role: "researcher", discrepancy_id: "real-2", origin: "real", code_only: false, eval_type: "eval", reference_available: false, answer: "yes" },
		{ model: "provider/model-a", role: "researcher", discrepancy_id: "synthetic-0", origin: "synthetic", code_only: false, eval_type: "eval", answer: "yes" },
	], realIds);

	assert.deepEqual(result.groups, [{
		model: "provider/model-a",
		role: "researcher",
		denominator: 92,
		evaluated_discrepancies: 2,
		recalled_discrepancies: 1,
		recall: 1 / 92,
	}]);
});

test("SciCoQA lane rejects a wrong denominator and unknown real discrepancy IDs", () => {
	assert.throws(() => scoreSciCoqaRows([{
		model: "provider/model-a",
		discrepancy_id: "real-0",
		origin: "real",
		code_only: false,
		eval_type: "eval",
		answer: "yes",
	}], ["real-only"]), /92 unique v1.1 real discrepancy IDs/);
	assert.throws(() => scoreSciCoqaRows([{
		model: "provider/model-a",
		discrepancy_id: "not-in-gold",
		origin: "real",
		code_only: false,
		eval_type: "eval",
		answer: "yes",
	}], Array.from({ length: 92 }, (_, index) => `real-${index}`)), /not-in-gold/);
});

test("score-lane CLI emits a machine-readable AstaBench summary", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-score-lane-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = join(root, "scores.jsonl");
	writeFileSync(input, JSON.stringify({
		id: "sample-a",
		model: "provider/model-a",
		role: "researcher",
		scores: { ingredient_recall: 1, answer_precision: 0.5, citation_precision: 0.75, citation_recall: 0.25 },
	}) + "\n");

	const result = spawnSync(process.execPath, [
		resolve("evals/score-lane.mjs"),
		"--lane",
		"scholarqa-cs2",
		"--input",
		input,
	], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });

	assert.equal(result.status, 0, result.stderr);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.benchmark, "ScholarQA-CS2");
	assert.equal(summary.split, "ScholarQA_CS2_validation");
	assert.equal(summary.groups[0].citation_precision, 0.75);
});

test("score-lane CLI aggregates DeepResearch FACT judge results", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-score-fact-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = join(root, "fact-results.jsonl");
	writeFileSync(input, JSON.stringify({
		id: "report-a",
		model: "provider/model-a",
		role: "reviewer",
		citations: [{ id: "[1]" }],
		citations_deduped: {
			"https://example.org/paper": {
				validate_error: null,
				validate_res: [{ result: "supported" }, { result: "unknown" }],
			},
		},
	}) + "\n");

	const result = spawnSync(process.execPath, [
		resolve("evals/score-lane.mjs"),
		"--lane",
		"deepresearch-fact",
		"--input",
		input,
	], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });

	assert.equal(result.status, 0, result.stderr);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.benchmark, "DeepResearch Bench FACT");
	assert.equal(summary.groups[0].citation_accuracy, 1);
});

test("score-lane CLI applies the SciCoQA v1.1 real denominator", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-score-scicoqa-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = join(root, "scicoqa-results.jsonl");
	const goldIds = join(root, "real-ids.json");
	writeFileSync(input, JSON.stringify({
		model: "provider/model-a",
		role: "verifier",
		discrepancy_id: "real-0",
		origin: "real",
		code_only: false,
		eval_type: "eval",
		reference_available: true,
		answer: "yes",
	}) + "\n");
	writeFileSync(goldIds, JSON.stringify(Array.from({ length: 92 }, (_, index) => `real-${index}`)) + "\n");

	const result = spawnSync(process.execPath, [
		resolve("evals/score-lane.mjs"),
		"--lane",
		"scicoqa",
		"--input",
		input,
		"--gold-ids",
		goldIds,
	], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });

	assert.equal(result.status, 0, result.stderr);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.benchmark, "SciCoQA");
	assert.equal(summary.groups[0].denominator, 92);
	assert.equal(summary.groups[0].recall, 1 / 92);
});

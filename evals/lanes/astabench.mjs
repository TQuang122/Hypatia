const METRICS = ["ingredient_recall", "answer_precision", "citation_precision", "citation_recall"];
const ASTABENCH_REVISION = "a9e338070ffff195cb4cc5ddcbcf9ca8805f141d";
const DATASET_REVISION = "a600dc767f850385f4664772e3ba7a7f8be17d5e";

function record(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	return value;
}

function scoreValue(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${label} must be a number between 0 and 1.`);
	}
	return value;
}

function mean(total, count) {
	return count ? total / count : null;
}

/**
 * Aggregate per-sample scores produced by the official AstaBench ScholarQA-CS2 scorer.
 * This function does not fetch gated data or make citation-judge calls.
 */
export function scoreAstaBenchRows(rows, { split = "validation" } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new Error("AstaBench input must contain at least one official per-sample score row.");
	}
	if (split !== "validation" && split !== "test") {
		throw new Error("ScholarQA-CS2 split must be validation or test.");
	}

	const groups = new Map();
	for (const [index, value] of rows.entries()) {
		const row = record(value, `AstaBench row ${index + 1}`);
		if (typeof row.model !== "string" || !row.model.trim()) {
			throw new Error(`AstaBench row ${index + 1} must identify its model.`);
		}
		const role = typeof row.role === "string" && row.role.trim() ? row.role : "workflow";
		const key = `${row.model}\u0000${role}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				model: row.model,
				role,
				samples: 0,
				totals: Object.fromEntries(METRICS.map((metric) => [metric, 0])),
				citationF1Total: 0,
				globalAvgTotal: 0,
			};
			groups.set(key, group);
		}

		const scores = record(row.scores, `AstaBench row ${index + 1} scores`);
		const values = Object.fromEntries(
			METRICS.map((metric) => [metric, scoreValue(scores[metric], `${metric} in row ${index + 1}`)]),
		);
		group.samples += 1;
		for (const metric of METRICS) group.totals[metric] += values[metric];
		group.citationF1Total += values.citation_precision + values.citation_recall
			? (2 * values.citation_precision * values.citation_recall) / (values.citation_precision + values.citation_recall)
			: 0;
		group.globalAvgTotal += METRICS.reduce((sum, metric) => sum + values[metric], 0) / METRICS.length;
	}

	return {
		benchmark: "ScholarQA-CS2",
		config: "AstaBench v1.0.0",
		evaluator_revision: ASTABENCH_REVISION,
		dataset_revision: DATASET_REVISION,
		split: `ScholarQA_CS2_${split}`,
		judge: "official per-sample scores supplied as input; no local judging performed",
		groups: [...groups.values()]
			.sort((left, right) => left.model.localeCompare(right.model) || left.role.localeCompare(right.role))
			.map((group) => ({
				model: group.model,
				role: group.role,
				samples: group.samples,
				...Object.fromEntries(METRICS.map((metric) => [metric, mean(group.totals[metric], group.samples)])),
				citation_f1: mean(group.citationF1Total, group.samples),
				global_avg: mean(group.globalAvgTotal, group.samples),
			})),
	};
}

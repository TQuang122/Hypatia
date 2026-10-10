function record(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	return value;
}

function requiredString(value, label) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value;
}

const EVALUATOR_REVISION = "f2735b5c3636759c22f9e936c0232de8bf545b67";
const DATASET_REVISION = "f7d27cdd3930dd1eaf67a217821e616cc62e9f8e";

/**
 * Aggregate per-claim results from the official DeepResearch Bench FACT validator.
 * Rows contain citations_deduped as emitted by the pinned evaluator.
 */
export function scoreDeepResearchFactRows(rows) {
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new Error("DeepResearch FACT input must contain at least one report row.");
	}

	const groups = new Map();
	for (const [index, value] of rows.entries()) {
		const row = record(value, `FACT row ${index + 1}`);
		const model = requiredString(row.model, `FACT row ${index + 1} model`);
		const role = typeof row.role === "string" && row.role.trim() ? row.role : "workflow";
		if (!Array.isArray(row.citations)) throw new Error(`FACT row ${index + 1} citations must be an array.`);
		const citationsDeduped = record(row.citations_deduped, `FACT row ${index + 1} citations_deduped`);
		const key = `${model}\u0000${role}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				model,
				role,
				reports: 0,
				reportsWithCitations: 0,
				supported: 0,
				unsupported: 0,
				unknown: 0,
				validationErrors: 0,
			};
			groups.set(key, group);
		}
		group.reports += 1;
		if (row.citations.length > 0) group.reportsWithCitations += 1;

		for (const [citationUrl, rawCitation] of Object.entries(citationsDeduped)) {
			const citation = record(rawCitation, `FACT citation ${citationUrl}`);
			if (citation.validate_error !== null && citation.validate_error !== undefined) {
				group.validationErrors += 1;
				continue;
			}
			if (!Array.isArray(citation.validate_res)) {
				throw new Error(`FACT citation ${citationUrl} validate_res must be an array.`);
			}
			for (const [resultIndex, rawResult] of citation.validate_res.entries()) {
				const result = record(rawResult, `FACT citation ${citationUrl} result ${resultIndex + 1}`);
				if (result.result === "supported") group.supported += 1;
				else if (result.result === "unsupported") group.unsupported += 1;
				else if (result.result === "unknown") group.unknown += 1;
				else throw new Error(`FACT citation ${citationUrl} has an unknown judgment label.`);
			}
		}
	}

	return {
		benchmark: "DeepResearch Bench FACT",
		evaluator_revision: EVALUATOR_REVISION,
		dataset_revision: DATASET_REVISION,
		evaluator: "original DeepResearch Bench FACT; LLM judgments and live page retrieval are external inputs",
		groups: [...groups.values()]
			.sort((left, right) => left.model.localeCompare(right.model) || left.role.localeCompare(right.role))
			.map((group) => {
				const known = group.supported + group.unsupported;
				return {
					model: group.model,
					role: group.role,
					reports: group.reports,
					reports_with_citations: group.reportsWithCitations,
					supported_claims: group.supported,
					unsupported_claims: group.unsupported,
					unknown_claims: group.unknown,
					validation_errors: group.validationErrors,
					citation_accuracy: known ? group.supported / known : null,
					effective_citations_per_task: group.supported / group.reports,
					official_style_effective_citations_per_cited_report: group.reportsWithCitations
						? group.supported / group.reportsWithCitations
						: null,
				};
			}),
	};
}

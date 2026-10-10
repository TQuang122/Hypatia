const REAL_DISCREPANCY_COUNT = 92;
const CODE_REVISION = "463162906459be508ed4a2294fcaede9fa072036";
const DATASET_REVISION = "6f598056828ae90cbee7a47f9e4f96a71e39c69d";

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

/**
 * Score official SciCoQA discrepancy-judge rows for the v1.1 real split.
 * The caller supplies the local gold ID list; no dataset records are bundled.
 */
export function scoreSciCoqaRows(rows, realDiscrepancyIds, { evalType = "eval" } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new Error("SciCoQA input must contain at least one evaluation row.");
	}
	if (!Array.isArray(realDiscrepancyIds)
		|| realDiscrepancyIds.length !== REAL_DISCREPANCY_COUNT
		|| realDiscrepancyIds.some((id) => typeof id !== "string" || !id.trim())
		|| new Set(realDiscrepancyIds).size !== REAL_DISCREPANCY_COUNT) {
		throw new Error(`SciCoQA v1.1 real split requires ${REAL_DISCREPANCY_COUNT} unique v1.1 real discrepancy IDs.`);
	}
	const goldIds = new Set(realDiscrepancyIds);
	const groups = new Map();

	for (const [index, value] of rows.entries()) {
		const row = record(value, `SciCoQA row ${index + 1}`);
		if (row.origin !== "real" && row.origin !== "synthetic") {
			throw new Error(`SciCoQA row ${index + 1} origin must be real or synthetic.`);
		}
		if (typeof row.code_only !== "boolean") {
			throw new Error(`SciCoQA row ${index + 1} code_only must be boolean.`);
		}
		requiredString(row.eval_type, `SciCoQA row ${index + 1} eval_type`);
		if (row.origin !== "real" || row.code_only || row.eval_type !== evalType || row.reference_available === false) {
			continue;
		}
		if (row.reference_available !== undefined && typeof row.reference_available !== "boolean") {
			throw new Error(`SciCoQA row ${index + 1} reference_available must be boolean.`);
		}

		const discrepancyId = requiredString(row.discrepancy_id, `SciCoQA row ${index + 1} discrepancy_id`);
		if (!goldIds.has(discrepancyId)) {
			throw new Error(`SciCoQA evaluation refers to unknown real discrepancy ID: ${discrepancyId}`);
		}
		const model = requiredString(row.model, `SciCoQA row ${index + 1} model`);
		const role = typeof row.role === "string" && row.role.trim() ? row.role : "workflow";
		if (row.answer !== "yes" && row.answer !== "no") {
			throw new Error(`SciCoQA row ${index + 1} answer must be yes or no.`);
		}
		const key = `${model}\u0000${role}`;
		let group = groups.get(key);
		if (!group) {
			group = { model, role, evaluatedIds: new Set(), recalledIds: new Set() };
			groups.set(key, group);
		}
		group.evaluatedIds.add(discrepancyId);
		if (row.answer === "yes") group.recalledIds.add(discrepancyId);
	}

	if (groups.size === 0) {
		throw new Error("SciCoQA input contains no eligible v1.1 real full-paper judgments.");
	}

	return {
		benchmark: "SciCoQA",
		dataset_version: "v1.1",
		code_revision: CODE_REVISION,
		dataset_revision: DATASET_REVISION,
		split: "real",
		denominator: REAL_DISCREPANCY_COUNT,
		matching: "official discrepancy-judge labels; each gold discrepancy ID counts at most once",
		groups: [...groups.values()]
			.sort((left, right) => left.model.localeCompare(right.model) || left.role.localeCompare(right.role))
			.map((group) => ({
				model: group.model,
				role: group.role,
				denominator: REAL_DISCREPANCY_COUNT,
				evaluated_discrepancies: group.evaluatedIds.size,
				recalled_discrepancies: group.recalledIds.size,
				recall: group.recalledIds.size / REAL_DISCREPANCY_COUNT,
			})),
	};
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USEFUL_RELEVANCE_MINIMUM = 2;
const HUMAN_REVIEW_COUNT = 20;

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rowKey(row, label, index) {
	const queryId = nonEmpty(row.query_id);
	const candidateId = nonEmpty(row.candidate_id);
	if (!queryId || !candidateId) {
		throw new Error(`${label} row ${index + 1} needs query_id and candidate_id.`);
	}
	return JSON.stringify([queryId, candidateId]);
}

function grade(value, field, label, index) {
	if (!Number.isInteger(value) || value < 0 || value > 3) {
		throw new Error(`${label} row ${index + 1}: ${field} must be an integer between 0 and 3.`);
	}
	return value;
}

function labelIndex(rows, label) {
	if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${label} must contain candidate rows.`);
	const byKey = new Map();
	for (const [index, value] of rows.entries()) {
		const row = record(value);
		const key = rowKey(row, label, index);
		if (byKey.has(key)) throw new Error(`${label} row ${index + 1}: duplicate candidate for query_id.`);
		if (!nonEmpty(row.query) || !nonEmpty(row.title) || typeof row.abstract !== "string") {
			throw new Error(`${label} row ${index + 1}: query, title, and abstract are required.`);
		}
		grade(row.relevance, "relevance", label, index);
		byKey.set(key, row);
	}
	return byKey;
}

function assertSameCandidateMetadata(left, right, label, index) {
	for (const field of ["query", "title", "abstract"]) {
		if (left[field] !== right[field]) {
			throw new Error(`${label} row ${index + 1}: ${field} differs for the same candidate.`);
		}
	}
}

function gradeCounts(rows) {
	return Object.fromEntries([0, 1, 2, 3].map((value) => [
		value,
		rows.filter((row) => row.relevance === value).length,
	]));
}

export function applyLayaHumanReview(baseRows, primaryRows, duplicateRows, reviewRows, { reviewer = "user" } = {}) {
	if (!["user", "assistant"].includes(reviewer)) throw new Error("reviewer must be user or assistant.");
	const baseByKey = labelIndex(baseRows, "base labels");
	const primaryByKey = labelIndex(primaryRows, "primary labels");
	const duplicateByKey = labelIndex(duplicateRows, "duplicate labels");
	if (baseByKey.size !== primaryByKey.size || [...primaryByKey.keys()].some((key) => !baseByKey.has(key))) {
		throw new Error("base and primary label candidate IDs do not match.");
	}

	for (const [index, [key, primary]] of [...primaryByKey].entries()) {
		assertSameCandidateMetadata(primary, baseByKey.get(key), "base labels", index);
	}

	const crossingKeys = new Set();
	for (const [index, [key, duplicate]] of [...duplicateByKey].entries()) {
		const primary = primaryByKey.get(key);
		if (!primary) throw new Error("duplicate labels contain a candidate absent from primary labels.");
		assertSameCandidateMetadata(primary, duplicate, "duplicate labels", index);
		if ((primary.relevance >= USEFUL_RELEVANCE_MINIMUM) !== (duplicate.relevance >= USEFUL_RELEVANCE_MINIMUM)) {
			crossingKeys.add(key);
		}
	}
	if (crossingKeys.size !== HUMAN_REVIEW_COUNT || !Array.isArray(reviewRows) || reviewRows.length !== HUMAN_REVIEW_COUNT) {
		throw new Error(`review sheet must cover all ${HUMAN_REVIEW_COUNT} threshold-crossing disagreements.`);
	}

	const decisions = new Map();
	for (const [index, value] of reviewRows.entries()) {
		const row = record(value);
		const key = rowKey(row, "human review", index);
		if (decisions.has(key)) throw new Error(`human review row ${index + 1}: duplicate candidate for query_id.`);
		if (!crossingKeys.has(key)) throw new Error(`human review row ${index + 1}: candidate is not a threshold-crossing disagreement.`);
		const primary = primaryByKey.get(key);
		const duplicate = duplicateByKey.get(key);
		if (primary.query !== row.query || primary.title !== row.title) {
			throw new Error(`human review row ${index + 1}: query or title differs for the same candidate.`);
		}
		const primaryRelevance = grade(row.primary_relevance, "primary_relevance", "human review", index);
		const duplicateRelevance = grade(row.double_relevance, "double_relevance", "human review", index);
		if (primaryRelevance !== primary.relevance) {
			throw new Error(`human review row ${index + 1}: raw primary grade differs from the source labels.`);
		}
		if (duplicateRelevance !== duplicate.relevance) {
			throw new Error(`human review row ${index + 1}: raw duplicate grade differs from the source labels.`);
		}
		if (row.reviewer !== undefined && row.reviewer !== reviewer) {
			throw new Error(`human review row ${index + 1}: reviewer differs from the selected reviewer.`);
		}
		const finalRelevance = grade(row.final_relevance, "final_relevance", "human review", index);
		const confidence = nonEmpty(row.confidence);
		if (confidence !== undefined && !["high", "medium", "low"].includes(confidence)) {
			throw new Error(`human review row ${index + 1}: confidence must be high, medium, or low.`);
		}
		const evidenceBasis = nonEmpty(row.evidence_basis);
		if (evidenceBasis !== undefined && !["title", "title_abstract"].includes(evidenceBasis)) {
			throw new Error(`human review row ${index + 1}: evidence_basis must be title or title_abstract.`);
		}
		const rationale = nonEmpty(row.rationale);
		if (reviewer === "assistant" && (!confidence || !evidenceBasis || !rationale)) {
			throw new Error(`assistant review row ${index + 1}: confidence, evidence_basis, and rationale are required.`);
		}
		decisions.set(key, { primaryRelevance, duplicateRelevance, finalRelevance, confidence, evidenceBasis, rationale });
	}
	if (decisions.size !== HUMAN_REVIEW_COUNT || [...crossingKeys].some((key) => !decisions.has(key))) {
		throw new Error(`review sheet must cover all ${HUMAN_REVIEW_COUNT} threshold-crossing disagreements.`);
	}

	let changedBaselineGrades = 0;
	const rows = baseRows.map((row) => {
		const key = JSON.stringify([row.query_id, row.candidate_id]);
		const decision = decisions.get(key);
		if (!decision) return row;
		if (row.relevance !== decision.finalRelevance) changedBaselineGrades += 1;
		return {
			...row,
			relevance: decision.finalRelevance,
			review_resolution: {
				primary_relevance: decision.primaryRelevance,
				double_relevance: decision.duplicateRelevance,
				final_relevance: decision.finalRelevance,
				reviewer,
				...(decision.confidence ? { confidence: decision.confidence } : {}),
				...(decision.evidenceBasis ? { evidence_basis: decision.evidenceBasis } : {}),
				...(decision.rationale ? { rationale: decision.rationale } : {}),
			},
		};
	});

	return {
		rows,
		summary: {
			baseCandidates: baseRows.length,
			primaryCandidates: primaryRows.length,
			duplicateCandidates: duplicateRows.length,
			thresholdCrossingDisagreements: crossingKeys.size,
			reviewer,
			resolvedCandidates: decisions.size,
			changedBaselineGrades,
			unchangedBaselineGrades: baseRows.length - changedBaselineGrades,
			finalGradeCounts: gradeCounts(rows),
		},
	};
}

function readJsonl(path) {
	const name = path.split(/[\\/]/u).at(-1);
	return readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line, index) => {
		if (!line.trim()) return [];
		try {
			const value = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw new Error("row must be an object");
			}
			return [value];
		} catch {
			throw new Error(`${name} contains invalid JSON object at line ${index + 1}.`);
		}
	});
}

function jsonl(rows) {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function requiredPath(value, name) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required.`);
	return resolve(value);
}

async function main() {
	const { values } = parseArgs({
		options: {
			"base-labels": { type: "string", default: "outputs/laya-hypatia-30-adjudicated-labels.jsonl" },
			"primary-labels": { type: "string", default: "outputs/laya-hypatia-30-abstracts-labels.jsonl" },
			"duplicate-labels": { type: "string", default: "outputs/laya-hypatia-30-abstracts-double-labels.jsonl" },
		review: { type: "string" },
			reviewer: { type: "string", default: "user" },
			"labels-output": { type: "string" },
			"summary-output": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"Usage: node evals/apply-laya-human-review.mjs [--base-labels <jsonl>] " +
			"[--primary-labels <jsonl>] [--duplicate-labels <jsonl>] [--review <jsonl>] [--reviewer <user|assistant>] " +
			"[--labels-output <jsonl>] [--summary-output <json>]\n",
		);
		return;
	}
	const reviewer = values.reviewer;
	if (!["user", "assistant"].includes(reviewer ?? "")) throw new Error("--reviewer must be user or assistant.");
	const inputPaths = {
		baseLabels: requiredPath(values["base-labels"], "base-labels"),
		primaryLabels: requiredPath(values["primary-labels"], "primary-labels"),
		duplicateLabels: requiredPath(values["duplicate-labels"], "duplicate-labels"),
		review: requiredPath(
			values.review ?? (reviewer === "user"
				? "outputs/laya-hypatia-20-human-review.jsonl"
				: "outputs/laya-hypatia-20-assistant-review.jsonl"),
			"review",
		),
	};
	const outputStem = reviewer === "user" ? "human" : "assistant";
	const outputPaths = {
		labels: requiredPath(
			values["labels-output"] ?? `outputs/laya-hypatia-30-${outputStem}-final-labels.jsonl`,
			"labels-output",
		),
		summary: requiredPath(
			values["summary-output"] ?? `outputs/laya-hypatia-30-${outputStem}-final-labels-summary.json`,
			"summary-output",
		),
	};
	if (new Set([...Object.values(inputPaths), ...Object.values(outputPaths)]).size !== 6) {
		throw new Error("Input and output paths must all be distinct.");
	}
	if (Object.values(outputPaths).some(existsSync)) throw new Error("Choose output paths that do not already exist.");

	const inputText = Object.fromEntries(Object.entries(inputPaths).map(([name, path]) => [name, readFileSync(path, "utf8")]));
	const result = applyLayaHumanReview(
		readJsonl(inputPaths.baseLabels),
		readJsonl(inputPaths.primaryLabels),
		readJsonl(inputPaths.duplicateLabels),
		readJsonl(inputPaths.review),
		{ reviewer },
	);
	const labelsText = jsonl(result.rows);
	const summary = {
		schema: "hypatia.layaReviewResolution.v1",
		...result.summary,
		inputs: Object.fromEntries(Object.entries(inputPaths).map(([name, path]) => [
			name,
			{ path, sha256: sha256(inputText[name]) },
		])),
		outputs: {
			labels: { path: outputPaths.labels, sha256: sha256(labelsText) },
		},
	};
	const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
	for (const path of Object.values(outputPaths)) mkdirSync(dirname(path), { recursive: true });
	const created = [];
	try {
		writeFileSync(outputPaths.labels, labelsText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.labels);
		writeFileSync(outputPaths.summary, summaryText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.summary);
	} catch (error) {
		for (const path of created) unlinkSync(path);
		throw error;
	}
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`Laya review resolution failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

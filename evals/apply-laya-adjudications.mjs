#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

function validateLabels(rows, label) {
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

function gradeCounts(rows) {
	return Object.fromEntries([0, 1, 2, 3].map((value) => [
		value,
		rows.filter((row) => row.relevance === value).length,
	]));
}

export function applyLayaAdjudications(primaryRows, duplicateRows, adjudicationRows) {
	const primaryByKey = validateLabels(primaryRows, "primary labels");
	const duplicateByKey = validateLabels(duplicateRows, "duplicate labels");
	const disagreementKeys = new Set();
	for (const [key, duplicate] of duplicateByKey) {
		const primary = primaryByKey.get(key);
		if (!primary) throw new Error("duplicate labels contain a candidate absent from primary labels.");
		for (const field of ["query", "title", "abstract", "abstract_missing", "retrieval_source", "doi", "arxiv_id", "url"]) {
			if (primary[field] !== duplicate[field]) {
				throw new Error(`duplicate-label metadata differs for ${duplicate.query_id}/${duplicate.candidate_id}.`);
			}
		}
		if (primary.relevance !== duplicate.relevance) disagreementKeys.add(key);
	}

	if (!Array.isArray(adjudicationRows)) throw new Error("adjudications must be an array.");
	const decisions = new Map();
	const adjudicators = new Set();
	for (const [index, value] of adjudicationRows.entries()) {
		const row = record(value);
		const key = rowKey(row, "adjudication", index);
		if (decisions.has(key)) throw new Error(`adjudication row ${index + 1}: duplicate candidate for query_id.`);
		if (!primaryByKey.has(key)) throw new Error(`adjudication row ${index + 1}: not a labeled candidate.`);
		if (!disagreementKeys.has(key)) throw new Error(`adjudication row ${index + 1}: candidate is not a disagreement.`);
		const relevance = grade(row.adjudicated_relevance, "adjudicated_relevance", "adjudication", index);
		const confidence = nonEmpty(row.confidence);
		if (!["high", "medium", "low"].includes(confidence ?? "")) {
			throw new Error(`adjudication row ${index + 1}: confidence must be high, medium, or low.`);
		}
		if (!nonEmpty(row.rationale)) throw new Error(`adjudication row ${index + 1}: rationale must be non-empty.`);
		const adjudicator = nonEmpty(row.adjudicator);
		if (!adjudicator) throw new Error(`adjudication row ${index + 1}: adjudicator must be non-empty.`);
		adjudicators.add(adjudicator);
		decisions.set(key, relevance);
	}
	const missing = [...disagreementKeys].filter((key) => !decisions.has(key));
	if (missing.length) throw new Error(`missing adjudication for ${missing.length} disagreement(s).`);

	const rows = primaryRows.map((row) => {
		const relevance = decisions.get(JSON.stringify([row.query_id, row.candidate_id]));
		return relevance === undefined ? row : { ...row, relevance };
	});
	return {
		rows,
		summary: {
			primaryCandidates: primaryRows.length,
			duplicateCandidates: duplicateRows.length,
			disagreements: disagreementKeys.size,
			adjudicatedCandidates: decisions.size,
			changedPrimaryGrades: [...decisions].filter(([key, relevance]) => primaryByKey.get(key)?.relevance !== relevance).length,
			adjudicators: [...adjudicators].toSorted(),
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
			labels: { type: "string" },
			"double-labels": { type: "string" },
			adjudications: { type: "string" },
			"labels-output": { type: "string" },
			"summary-output": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"Usage: node evals/apply-laya-adjudications.mjs --labels <jsonl> --double-labels <jsonl> " +
			"--adjudications <jsonl> --labels-output <jsonl> --summary-output <json>\n",
		);
		return;
	}
	const inputPaths = {
		labels: requiredPath(values.labels, "labels"),
		doubleLabels: requiredPath(values["double-labels"], "double-labels"),
		adjudications: requiredPath(values.adjudications, "adjudications"),
	};
	const outputPaths = {
		labels: requiredPath(values["labels-output"], "labels-output"),
		summary: requiredPath(values["summary-output"], "summary-output"),
	};
	if (new Set([...Object.values(inputPaths), ...Object.values(outputPaths)]).size !== 5) {
		throw new Error("Input and output paths must all be distinct.");
	}
	if (Object.values(outputPaths).some(existsSync)) throw new Error("Choose output paths that do not already exist.");

	const inputText = Object.fromEntries(Object.entries(inputPaths).map(([name, path]) => [name, readFileSync(path, "utf8")]));
	const result = applyLayaAdjudications(
		readJsonl(inputPaths.labels),
		readJsonl(inputPaths.doubleLabels),
		readJsonl(inputPaths.adjudications),
	);
	const labelsText = jsonl(result.rows);
	const summary = {
		schema: "hypatia.layaAdjudication.v1",
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
		process.stderr.write(`Laya adjudication application failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

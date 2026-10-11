#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { testableScienceDatabases } from "../extensions/research-tools/science-databases.js";

const DEFAULT_IDS = ["q01", "q02", "q03", "q04", "q05", "q06", "q10", "q11", "q12"];

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableCandidateId(row, source) {
	const paperId = nonEmpty(row.paperId);
	if (paperId) return `semanticscholar:${paperId}`;
	const openAlexId = nonEmpty(row.openalexId);
	if (openAlexId) return `openalex:${openAlexId}`;
	const doi = nonEmpty(row.doi);
	return doi ? `doi:${doi}` : undefined;
}

export function buildCandidatePoolRows({ queryId, query, searchQuery = query, response }) {
	const payload = record(response);
	const source = nonEmpty(payload.source) ?? "unknown";
	const results = Array.isArray(payload.results) ? payload.results : [];
	const seen = new Set();
	const labels = [];
	const rankings = [];
	let skipped = 0;

	for (const [index, item] of results.entries()) {
		const row = record(item);
		const candidateId = stableCandidateId(row, source);
		const title = nonEmpty(row.title);
		if (!candidateId || !title || seen.has(candidateId)) {
			skipped += 1;
			continue;
		}
		seen.add(candidateId);
		const abstract = nonEmpty(row.abstract) ?? "";
		labels.push({
			query_id: queryId,
			candidate_id: candidateId,
			query,
			title,
			abstract,
			relevance: null,
			abstract_missing: abstract === "",
			retrieval_source: source,
			doi: nonEmpty(row.doi) ?? "",
			arxiv_id: nonEmpty(row.arxivId) ?? "",
			url: nonEmpty(row.url) ?? "",
		});
		rankings.push({
			query_id: queryId,
			candidate_id: candidateId,
			baseline_rank: index + 1,
			source,
			search_query: searchQuery,
		});
	}

	return {
		labels: labels.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)),
		rankings,
		skipped,
	};
}

export function parseQueryOverrides(text, selectedIds) {
	const overrides = new Map();
	for (const [index, line] of text.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			throw new Error(`Query overrides have invalid JSON at line ${index + 1}.`);
		}
		const id = nonEmpty(row?.id);
		const searchQuery = nonEmpty(row?.search_query);
		if (!id) throw new Error(`Query overrides line ${index + 1} needs id.`);
		if (!searchQuery) throw new Error(`Query overrides line ${index + 1}: search_query must be non-empty.`);
		if (!selectedIds.has(id)) throw new Error(`Query override query ID ${id} is not in the selected question set.`);
		if (overrides.has(id)) throw new Error(`Query overrides contain duplicate query ID ${id}.`);
		overrides.set(id, searchQuery);
	}
	return overrides;
}

export function parseQueryManifest(text) {
	const questions = new Map();
	for (const [index, line] of text.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			throw new Error(`Question manifest has invalid JSON at line ${index + 1}.`);
		}
		const id = nonEmpty(row?.id);
		const question = nonEmpty(row?.question);
		if (!id || !question) throw new Error(`Question manifest line ${index + 1} needs id and question.`);
		if (questions.has(id)) throw new Error(`Question manifest contains duplicate question ID ${id}.`);
		questions.set(id, question);
	}
	if (!questions.size) throw new Error("Question manifest contains no questions.");
	return questions;
}

async function main() {
	const { values } = parseArgs({
		options: {
			ids: { type: "string" },
			limit: { type: "string", default: "20" },
			source: { type: "string", default: "semanticscholar" },
			"questions-jsonl": { type: "string" },
			"query-overrides": { type: "string" },
			"labels-output": { type: "string", default: "outputs/decision-model-systems-hypatia-labels.jsonl" },
			"rankings-output": { type: "string", default: "outputs/decision-model-systems-hypatia-ranks.jsonl" },
		},
	});
	const questionsPath = resolve(values["questions-jsonl"] ?? "evals/questions.jsonl");
	const questions = parseQueryManifest(readFileSync(questionsPath, "utf8"));
	const ids = values.ids === undefined
		? values["questions-jsonl"] ? [...questions.keys()] : DEFAULT_IDS
		: values.ids.split(",").map((id) => id.trim()).filter(Boolean);
	if (!ids.length || new Set(ids).size !== ids.length) throw new Error("ids must be a non-empty unique comma-separated list.");
	const limit = Number(values.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be an integer from 1 to 20.");
	if (!["semanticscholar", "openalex"].includes(values.source ?? "")) {
		throw new Error("source must be semanticscholar or openalex.");
	}
	const labelsPath = resolve(values["labels-output"] ?? "");
	const rankingsPath = resolve(values["rankings-output"] ?? "");
	if (labelsPath === rankingsPath || existsSync(labelsPath) || existsSync(rankingsPath)) {
		throw new Error("Choose two distinct output paths that do not already exist.");
	}
	const missingIds = ids.filter((id) => !questions.has(id));
	if (missingIds.length) throw new Error(`Unknown question IDs: ${missingIds.join(", ")}.`);
	const queryOverrides = values["query-overrides"]
		? parseQueryOverrides(readFileSync(resolve(values["query-overrides"]), "utf8"), new Set(ids))
		: new Map();

	const labels = [];
	const rankings = [];
	const queries = [];
	for (const queryId of ids) {
		const query = questions.get(queryId);
		const searchQuery = queryOverrides.get(queryId) ?? query;
		const response = await testableScienceDatabases.scienceDatabaseSearch({
			source: values.source,
			query: searchQuery,
			limit,
		});
		const pool = buildCandidatePoolRows({ queryId, query, searchQuery, response });
		if (!pool.labels.length) throw new Error(`No candidates with stable IDs and titles for ${queryId}.`);
		labels.push(...pool.labels);
		rankings.push(...pool.rankings);
		queries.push({
			queryId,
			returned: pool.labels.length,
			skipped: pool.skipped,
			source: response.source,
			searchQuery,
			usedQueryOverride: searchQuery !== query,
			fallbackNote: response.fallbackNote ?? null,
			abstractMissing: pool.labels.filter((row) => row.abstract_missing).length,
		});
	}

	mkdirSync(dirname(labelsPath), { recursive: true });
	mkdirSync(dirname(rankingsPath), { recursive: true });
	writeFileSync(labelsPath, `${labels.map((row) => JSON.stringify(row)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
	try {
		writeFileSync(rankingsPath, `${rankings.map((row) => JSON.stringify(row)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		unlinkSync(labelsPath);
		throw error;
	}
	console.log(JSON.stringify({
		labelsOutput: labelsPath,
		rankingsOutput: rankingsPath,
		questionsManifest: questionsPath,
		labelStatus: "relevance is null and requires trusted human annotation; no expected-key-paper labels were used",
		baselineName: "Hypatia science-database retrieval order",
		queries,
		totalCandidates: labels.length,
		totalMissingAbstracts: labels.filter((row) => row.abstract_missing).length,
	}, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`Hypatia Laya label-pool preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

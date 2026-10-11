#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_DATA_DIR = "/tmp/hypatia-scifact-dev/data";
const DEFAULT_EXCLUDED_IDS = ["1", "3", "5", "13", "36"];
const DEFAULT_SEED = "hypatia-laya-scifact-dev-20261011";

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function claimId(value) {
	return value === undefined || value === null ? undefined : String(value);
}

function tokenize(value) {
	return String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function abstractText(value) {
	if (Array.isArray(value)) return value.map(nonEmpty).filter(Boolean).join(" ");
	return nonEmpty(value) ?? "";
}

function buildBm25Index(corpus) {
	if (!corpus.length) throw new Error("SciFact corpus contains no documents.");
	const documentFrequency = new Map();
	const documents = corpus.map((item, index) => {
		const row = record(item);
		const id = claimId(row.doc_id ?? row._id);
		const title = nonEmpty(row.title) ?? "";
		const abstract = abstractText(row.abstract);
		if (!id) throw new Error(`SciFact corpus row ${index + 1} has no document ID.`);
		const termFrequency = new Map();
		for (const term of tokenize(`${title} ${abstract}`)) {
			termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
		}
		for (const term of termFrequency.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
		return { id, title, abstract, length: [...termFrequency.values()].reduce((sum, count) => sum + count, 0), termFrequency };
	});
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	return { documentFrequency, documents, averageLength };
}

function rankWithIndex(query, index, limit) {
	const terms = new Set(tokenize(query));
	return index.documents.map((document) => {
		let score = 0;
		for (const term of terms) {
			const frequency = document.termFrequency.get(term) ?? 0;
			if (!frequency) continue;
			const documentFrequency = index.documentFrequency.get(term) ?? 0;
			const inverseFrequency = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
			const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * document.length / index.averageLength);
			score += inverseFrequency * (frequency * 2.2) / denominator;
		}
		return { docId: document.id, title: document.title, abstract: document.abstract, score };
	}).sort((left, right) => right.score - left.score || left.docId.localeCompare(right.docId)).slice(0, limit);
}

export function rankBm25Candidates(query, corpus, limit = 20) {
	if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer.");
	return rankWithIndex(query, buildBm25Index(corpus), limit);
}

export function selectScifactDevClaims(claims, { count, excludedIds = new Set(), seed = DEFAULT_SEED }) {
	if (!Number.isInteger(count) || count < 1) throw new Error("query count must be a positive integer.");
	const seen = new Set();
	const candidates = claims.map((claim, index) => {
		const row = record(claim);
		const id = claimId(row.id);
		const text = nonEmpty(row.claim);
		if (!id || !text) throw new Error(`SciFact claim row ${index + 1} needs id and claim text.`);
		if (seen.has(id)) throw new Error(`SciFact dev claims contain duplicate ID ${id}.`);
		seen.add(id);
		return {
			claim: row,
			id,
			hasEvidence: Object.keys(record(row.evidence)).length > 0,
			key: createHash("sha256").update(`${seed}:${id}`).digest("hex"),
		};
	}).filter(({ id, hasEvidence }) => !excludedIds.has(id) && hasEvidence);
	if (candidates.length < count) throw new Error(`Only ${candidates.length} SciFact dev claims remain after exclusions; ${count} requested.`);
	return candidates
		.sort((left, right) => left.key.localeCompare(right.key) || left.id.localeCompare(right.id))
		.slice(0, count)
		.sort((left, right) => left.id.localeCompare(right.id))
		.map(({ claim }) => claim);
}

export function buildScifactRows(claim, candidates) {
	const row = record(claim);
	const id = claimId(row.id);
	const query = nonEmpty(row.claim);
	if (!id || !query) throw new Error("SciFact claim needs id and claim text.");
	const evidence = record(row.evidence);
	const relevantIds = new Set(Object.keys(evidence));
	const labels = [];
	const rankings = [];
	for (const [index, candidate] of candidates.entries()) {
		const docId = claimId(candidate.docId);
		const title = nonEmpty(candidate.title);
		if (!docId || !title) throw new Error(`Ranked SciFact candidate ${index + 1} needs a document ID and title.`);
		const abstract = abstractText(candidate.abstract);
		const candidateId = `scifact:${docId}`;
		labels.push({
			query_id: `scifact-dev:${id}`,
			candidate_id: candidateId,
			query,
			title,
			abstract,
			relevance: relevantIds.has(docId) ? 1 : 0,
			abstract_missing: abstract === "",
			retrieval_source: "scifact-bm25-title-abstract",
			label_source: "scifact-dev-evidence-qrels",
			doi: "",
			arxiv_id: "",
			url: "",
		});
		rankings.push({
			query_id: `scifact-dev:${id}`,
			candidate_id: candidateId,
			baseline_rank: index + 1,
			baseline_score: candidate.score,
			source: "scifact-bm25-title-abstract",
			search_query: query,
		});
	}
	return { labels, rankings };
}

function readJsonl(path) {
	const text = readFileSync(path, "utf8");
	const rows = text.split(/\r?\n/u).flatMap((line, index) => {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line)];
		} catch {
			throw new Error(`${path} contains invalid JSON at line ${index + 1}.`);
		}
	});
	return { rows, sha256: createHash("sha256").update(text).digest("hex") };
}

async function main() {
	const { values } = parseArgs({
		options: {
			"data-dir": { type: "string", default: DEFAULT_DATA_DIR },
			"query-count": { type: "string", default: "30" },
			limit: { type: "string", default: "20" },
			"exclude-ids": { type: "string", default: DEFAULT_EXCLUDED_IDS.join(",") },
			seed: { type: "string", default: DEFAULT_SEED },
			"labels-output": { type: "string", default: "outputs/decision-model-systems-scifact-dev-labels.jsonl" },
			"rankings-output": { type: "string", default: "outputs/decision-model-systems-scifact-dev-ranks.jsonl" },
		},
	});
	const queryCount = Number(values["query-count"]);
	const limit = Number(values.limit);
	if (!Number.isInteger(queryCount) || queryCount < 1) throw new Error("query-count must be a positive integer.");
	if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be an integer from 1 to 20.");
	const labelsPath = resolve(values["labels-output"] ?? "");
	const rankingsPath = resolve(values["rankings-output"] ?? "");
	if (labelsPath === rankingsPath || existsSync(labelsPath) || existsSync(rankingsPath)) {
		throw new Error("Choose two distinct output paths that do not already exist.");
	}

	const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
	const claimsData = readJsonl(resolve(dataDir, "claims_dev.jsonl"));
	const corpusData = readJsonl(resolve(dataDir, "corpus.jsonl"));
	const excludedIds = new Set((values["exclude-ids"] ?? "").split(",").map((id) => id.trim()).filter(Boolean));
	const selectedClaims = selectScifactDevClaims(claimsData.rows, {
		count: queryCount,
		excludedIds,
		seed: values.seed ?? DEFAULT_SEED,
	});
	const index = buildBm25Index(corpusData.rows);
	const labels = [];
	const rankings = [];
	const queries = [];
	for (const claim of selectedClaims) {
		const candidates = rankWithIndex(nonEmpty(record(claim).claim) ?? "", index, limit);
		const pool = buildScifactRows(claim, candidates);
		labels.push(...pool.labels);
		rankings.push(...pool.rankings);
		queries.push({
			queryId: String(record(claim).id),
			returned: pool.labels.length,
			relevantInPool: pool.labels.filter((row) => row.relevance > 0).length,
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
	process.stdout.write(`${JSON.stringify({
		benchmark: "SciFact claims_dev",
		labelsOutput: labelsPath,
		rankingsOutput: rankingsPath,
		labelsSha256: createHash("sha256").update(`${labels.map((row) => JSON.stringify(row)).join("\n")}\n`).digest("hex"),
		rankingsSha256: createHash("sha256").update(`${rankings.map((row) => JSON.stringify(row)).join("\n")}\n`).digest("hex"),
		claimsSha256: claimsData.sha256,
		corpusSha256: corpusData.sha256,
		baselineName: "SciFact dev BM25 title+abstract",
		bm25: { k1: 1.2, b: 0.75, tieBreak: "document ID ascending" },
		querySelection: { count: queryCount, seed: values.seed ?? DEFAULT_SEED, excludedIds: [...excludedIds], selectedIds: queries.map((query) => query.queryId) },
		excludedNoEvidenceClaims: claimsData.rows.filter((claim) => Object.keys(record(record(claim).evidence)).length === 0).length,
		totalCandidates: labels.length,
		totalRelevantInPool: labels.filter((row) => row.relevance > 0).length,
		totalMissingAbstracts: labels.filter((row) => row.abstract_missing).length,
		queries,
	}, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`SciFact Laya pool preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

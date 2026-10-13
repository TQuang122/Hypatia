import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function parseCsv(text, sourceName) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (character === '"') {
				quoted = false;
			} else {
				field += character;
			}
		} else if (character === '"' && field.length === 0) {
			quoted = true;
		} else if (character === ",") {
			row.push(field);
			field = "";
		} else if (character === "\n" || character === "\r") {
			row.push(field);
			field = "";
			if (row.some((value) => value !== "")) rows.push(row);
			row = [];
			if (character === "\r" && text[index + 1] === "\n") index += 1;
		} else {
			field += character;
		}
	}
	if (quoted) throw new Error(`${sourceName} has an unterminated quoted CSV field.`);
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		if (row.some((value) => value !== "")) rows.push(row);
	}
	const headers = rows.shift();
	const normalizedHeaders = headers?.map((header) => header.trim());
	if (
		!normalizedHeaders
		|| normalizedHeaders.some((header) => header === "")
		|| new Set(normalizedHeaders).size !== normalizedHeaders.length
	) {
		throw new Error(`${sourceName} needs a CSV header with unique, non-empty names.`);
	}
	return rows.map((values, index) => {
		if (values.length !== headers.length) throw new Error(`${sourceName} row ${index + 2} has the wrong number of columns.`);
		return Object.fromEntries(normalizedHeaders.map((header, column) => [header, values[column]]));
	});
}

function readRows(path) {
	const source = resolve(path);
	const text = readFileSync(source, "utf8");
	if (source.toLowerCase().endsWith(".csv")) return parseCsv(text, basename(source));
	if (!source.toLowerCase().endsWith(".jsonl")) throw new Error(`${basename(source)} must be JSONL or CSV.`);
	return text.split(/\r?\n/u).flatMap((line, index) => {
		if (line.trim() === "") return [];
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`${basename(source)} contains invalid JSON at line ${index + 1}.`);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${basename(source)} line ${index + 1} must contain an object.`);
		}
		return [value];
	});
}

function requiredText(row, field, rowNumber) {
	const value = row[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`candidate row ${rowNumber}: ${field} must be a non-empty string.`);
	}
	return value.trim();
}

function integer(value, field, rowNumber) {
	const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : Number.NaN;
	if (!Number.isInteger(parsed)) throw new Error(`candidate row ${rowNumber}: ${field} must be an integer.`);
	return parsed;
}

function normalizeCandidates(rows, rankField) {
	if (rows.length === 0) throw new Error("candidate input contains no rows.");
	const ids = new Set();
	const ranks = new Set();
	const queries = new Map();
	return rows.map((row, index) => {
		const rowNumber = index + 1;
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`candidate row ${rowNumber} must be an object.`);
		}
		const queryId = requiredText(row, "query_id", rowNumber);
		const candidateId = requiredText(row, "candidate_id", rowNumber);
		const query = requiredText(row, "query", rowNumber);
		const title = requiredText(row, "title", rowNumber);
		const abstract = row.abstract ?? "";
		if (typeof abstract !== "string") throw new Error(`candidate row ${rowNumber}: abstract must be a string.`);
		const relevance = integer(row.relevance, "relevance", rowNumber);
		const candidateRank = integer(row[rankField], rankField, rowNumber);
		if (relevance < 0 || relevance > 3) throw new Error(`candidate row ${rowNumber}: relevance must be between 0 and 3.`);
		if (candidateRank < 1) throw new Error(`candidate row ${rowNumber}: ${rankField} must be positive.`);
		const id = JSON.stringify([queryId, candidateId]);
		const rank = JSON.stringify([queryId, candidateRank]);
		if (ids.has(id)) throw new Error(`candidate row ${rowNumber}: duplicate candidate_id for query_id.`);
		if (ranks.has(rank)) throw new Error(`candidate row ${rowNumber}: duplicate ${rankField} for query_id.`);
		if (queries.has(queryId) && queries.get(queryId) !== query) {
			throw new Error(`candidate row ${rowNumber}: query text differs within query_id.`);
		}
		ids.add(id);
		ranks.add(rank);
		queries.set(queryId, query);
		return {
			queryId,
			candidateId,
			query,
			title,
			abstract: abstract.trim(),
			relevance,
			...(rankField === "jev_rank" ? { jevRank: candidateRank } : { baselineRank: candidateRank }),
		};
	});
}

function mergeRankings(labelRows, rankingRows, { name, rowName, rankField, allowRankAlias = false }) {
	if (labelRows.length === 0 || rankingRows.length === 0) throw new Error(`label and ${name} ranking files must both contain rows.`);
	if (labelRows.some((row) => String(row[rankField] ?? "").trim() !== "")) {
		throw new Error(`provide ${name} ranks inline or in a separate file, not both.`);
	}
	const rankMap = new Map();
	for (const [index, row] of rankingRows.entries()) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`${rowName} ${index + 1} must be an object.`);
		}
		const queryId = requiredText(row, "query_id", index + 1);
		const candidateId = requiredText(row, "candidate_id", index + 1);
		const rankValue = allowRankAlias ? row[rankField] ?? row.rank : row[rankField];
		const key = JSON.stringify([queryId, candidateId]);
		if (rankMap.has(key)) throw new Error(`${rowName} ${index + 1}: duplicate candidate for query_id.`);
		rankMap.set(key, rankValue);
	}
	const labelKeys = new Set();
	let missing = 0;
	const joined = labelRows.map((row, index) => {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`label row ${index + 1} must be an object.`);
		}
		const queryId = requiredText(row, "query_id", index + 1);
		const candidateId = requiredText(row, "candidate_id", index + 1);
		const key = JSON.stringify([queryId, candidateId]);
		labelKeys.add(key);
		if (!rankMap.has(key)) {
			missing += 1;
			return row;
		}
		return { ...row, [rankField]: rankMap.get(key) };
	});
	const extra = [...rankMap.keys()].filter((key) => !labelKeys.has(key)).length;
	if (missing || extra) throw new Error(`label and ${name} candidate IDs do not match (missing=${missing}, extra=${extra}).`);
	return joined;
}

function mergeJevRanks(labelRows, rankingRows) {
	return mergeRankings(labelRows, rankingRows, {
		name: "Jev",
		rowName: "Jev row",
		rankField: "jev_rank",
		allowRankAlias: true,
	});
}

function mergeBaselineRanks(labelRows, rankingRows) {
	return mergeRankings(labelRows, rankingRows, {
		name: "baseline",
		rowName: "baseline ranking row",
		rankField: "baseline_rank",
	});
}

export function parseCutoffs(value) {
	const cutoffs = value.split(",").map((part) => Number(part.trim()));
	if (cutoffs.length === 0 || cutoffs.some((cutoff) => !Number.isInteger(cutoff) || cutoff < 1)) {
		throw new Error("cutoffs must be comma-separated positive integers.");
	}
	if (new Set(cutoffs).size !== cutoffs.length) throw new Error("cutoffs must be unique.");
	return cutoffs;
}

export function loadCandidateRows(labelsPath, {
	jevRankingsPath = null,
	baselineName = null,
	baselineRankingsPath = null,
} = {}) {
	const normalizedBaselineName = baselineName === null ? null : baselineName.trim();
	if (normalizedBaselineName === "") throw new Error("baseline-name must be a non-empty string.");
	if (normalizedBaselineName === null && baselineRankingsPath !== null) {
		throw new Error("--baseline-rankings requires --baseline-name.");
	}
	if (normalizedBaselineName !== null && jevRankingsPath !== null) {
		throw new Error("--baseline-name cannot be combined with --jev-rankings.");
	}
	if (baselineRankingsPath !== null && jevRankingsPath !== null) {
		throw new Error("--baseline-rankings cannot be combined with --jev-rankings.");
	}
	const resolvedLabelsPath = resolve(labelsPath);
	const labelBytes = readFileSync(resolvedLabelsPath);
	const labelRows = readRows(resolvedLabelsPath);
	const resolvedJevRankingsPath = jevRankingsPath ? resolve(jevRankingsPath) : null;
	const resolvedBaselineRankingsPath = baselineRankingsPath ? resolve(baselineRankingsPath) : null;
	const jevRankingBytes = resolvedJevRankingsPath ? readFileSync(resolvedJevRankingsPath) : null;
	const baselineRankingBytes = resolvedBaselineRankingsPath ? readFileSync(resolvedBaselineRankingsPath) : null;
	const rankField = normalizedBaselineName === null
		? "jev_rank"
		: resolvedBaselineRankingsPath ? "baseline_rank" : "retrieval_rank";
	let rows = labelRows;
	if (resolvedBaselineRankingsPath) rows = mergeBaselineRanks(labelRows, readRows(resolvedBaselineRankingsPath));
	else if (resolvedJevRankingsPath) rows = mergeJevRanks(labelRows, readRows(resolvedJevRankingsPath));
	return {
		rows: normalizeCandidates(rows, rankField),
		label: {
			name: basename(resolvedLabelsPath),
			sha256: createHash("sha256").update(labelBytes).digest("hex"),
		},
		jev: normalizedBaselineName !== null
			? null
			: resolvedJevRankingsPath
				? {
						name: basename(resolvedJevRankingsPath),
						sha256: createHash("sha256").update(jevRankingBytes).digest("hex"),
					}
				: "inline",
		baseline: normalizedBaselineName === null
			? null
			: {
					name: normalizedBaselineName,
					rankings: resolvedBaselineRankingsPath
						? {
								name: basename(resolvedBaselineRankingsPath),
								sha256: createHash("sha256").update(baselineRankingBytes).digest("hex"),
							}
						: "inline",
					rankField: resolvedBaselineRankingsPath ? "baseline_rank" : "retrieval_rank",
				},
	};
}

export const USEFUL_RELEVANCE_MINIMUM = 2;

function summarizeLabels(rows) {
	const relevanceGrades = Object.fromEntries([0, 1, 2, 3].map((grade) => [
		grade,
		rows.filter((row) => row.relevance === grade).length,
	]));
	return {
		candidates: rows.length,
		queries: new Set(rows.map((row) => row.queryId)).size,
		relevantCandidates: rows.filter((row) => row.relevance > 0).length,
		nonRelevantCandidates: relevanceGrades[0],
		answerUsefulCandidates: rows.filter((row) => row.relevance >= USEFUL_RELEVANCE_MINIMUM).length,
		notUsefulCandidates: rows.filter((row) => row.relevance < USEFUL_RELEVANCE_MINIMUM).length,
		relevanceGrades,
		titleOnlyCandidates: rows.filter((row) => row.abstract.trim() === "").length,
		abstractCandidates: rows.filter((row) => row.abstract.trim() !== "").length,
	};
}

export function balanceTrainingRows(rows, { seed = "hypatia-laya-balanced-training-v1" } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) throw new Error("training balance requires candidate rows.");
	if (typeof seed !== "string" || seed.trim() === "") throw new Error("training balance seed must be a non-empty string.");
	const candidateKeys = new Set();
	for (const [index, row] of rows.entries()) {
		const rowNumber = index + 1;
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`candidate row ${rowNumber} must be an object.`);
		}
		const queryId = requiredText(row, "queryId", rowNumber);
		const candidateId = requiredText(row, "candidateId", rowNumber);
		if (!Number.isInteger(row.relevance) || row.relevance < 0 || row.relevance > 3) {
			throw new Error(`candidate row ${rowNumber}: relevance must be an integer between 0 and 3.`);
		}
		if (typeof row.abstract !== "string") throw new Error(`candidate row ${rowNumber}: abstract must be a string.`);
		const key = JSON.stringify([queryId, candidateId]);
		if (candidateKeys.has(key)) throw new Error(`candidate row ${rowNumber}: duplicate candidate_id for query_id.`);
		candidateKeys.add(key);
	}

	const usefulRows = rows.filter((row) => row.relevance >= USEFUL_RELEVANCE_MINIMUM);
	const notUsefulRows = rows.filter((row) => row.relevance < USEFUL_RELEVANCE_MINIMUM);
	if (usefulRows.length === 0 || notUsefulRows.length === 0) {
		throw new Error("balanced training rows require both useful and not-useful candidates.");
	}
	const targetPerClass = Math.min(usefulRows.length, notUsefulRows.length);
	const choose = (candidates) => new Set(candidates
		.toSorted((left, right) => {
			const leftKey = createHash("sha256").update(`${seed}:${left.queryId}:${left.candidateId}`).digest("hex");
			const rightKey = createHash("sha256").update(`${seed}:${right.queryId}:${right.candidateId}`).digest("hex");
			return leftKey.localeCompare(rightKey) || left.candidateId.localeCompare(right.candidateId);
		})
		.slice(0, targetPerClass)
		.map((row) => JSON.stringify([row.queryId, row.candidateId])));
	const selected = new Set([...choose(usefulRows), ...choose(notUsefulRows)]);
	const balancedRows = rows.filter((row) => selected.has(JSON.stringify([row.queryId, row.candidateId])));
	return {
		rows: balancedRows,
		before: summarizeLabels(rows),
		after: summarizeLabels(balancedRows),
		omittedCandidates: rows.length - balancedRows.length,
	};
}

export function splitRowsByQuery(rows, { testQueryIds } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) throw new Error("query split requires candidate rows.");
	if (!Array.isArray(testQueryIds) || testQueryIds.length === 0) {
		throw new Error("test-query-ids must be a non-empty array of query IDs.");
	}
	const normalizedTestQueryIds = testQueryIds.map((queryId, index) => {
		if (typeof queryId !== "string" || queryId.trim() === "") {
			throw new Error(`test query ID ${index + 1} must be a non-empty string.`);
		}
		return queryId.trim();
	});
	if (new Set(normalizedTestQueryIds).size !== normalizedTestQueryIds.length) {
		throw new Error("test-query-ids must be unique.");
	}

	const queryText = new Map();
	const candidateKeys = new Set();
	for (const [index, row] of rows.entries()) {
		const rowNumber = index + 1;
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`candidate row ${rowNumber} must be an object.`);
		}
		const queryId = requiredText(row, "queryId", rowNumber);
		const query = requiredText(row, "query", rowNumber);
		const candidateId = requiredText(row, "candidateId", rowNumber);
		if (!Number.isInteger(row.relevance) || row.relevance < 0 || row.relevance > 3) {
			throw new Error(`candidate row ${rowNumber}: relevance must be an integer between 0 and 3.`);
		}
		if (typeof row.abstract !== "string") throw new Error(`candidate row ${rowNumber}: abstract must be a string.`);
		const key = JSON.stringify([queryId, candidateId]);
		if (candidateKeys.has(key)) throw new Error(`candidate row ${rowNumber}: duplicate candidate_id for query_id.`);
		if (queryText.has(queryId) && queryText.get(queryId) !== query) {
			throw new Error(`candidate row ${rowNumber}: query text differs within query_id.`);
		}
		candidateKeys.add(key);
		queryText.set(queryId, query);
	}

	const queryIds = [...queryText.keys()];
	if (queryIds.length < 2) throw new Error("query split requires at least two distinct queries.");
	const unknownTestQueryIds = normalizedTestQueryIds.filter((queryId) => !queryText.has(queryId));
	if (unknownTestQueryIds.length > 0) {
		throw new Error(`test query IDs not present in candidate rows: ${unknownTestQueryIds.join(", ")}.`);
	}
	if (normalizedTestQueryIds.length >= queryIds.length) {
		throw new Error("test query IDs must leave at least one training query.");
	}
	const sortedTestQueryIds = normalizedTestQueryIds.toSorted();
	const testQuerySet = new Set(sortedTestQueryIds);
	const trainQueryIds = queryIds.filter((queryId) => !testQuerySet.has(queryId)).toSorted();
	const trainRows = rows.filter((row) => !testQuerySet.has(row.queryId));
	const testRows = rows.filter((row) => testQuerySet.has(row.queryId));
	return {
		trainQueryIds,
		testQueryIds: sortedTestQueryIds,
		trainRows,
		testRows,
		trainSummary: summarizeLabels(trainRows),
		testSummary: summarizeLabels(testRows),
	};
}

export function localOrigin(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Laya base URL must be a valid loopback HTTP origin.");
	}
	if (
		url.protocol !== "http:"
		|| !["127.0.0.1", "[::1]"].includes(url.hostname)
		|| url.username !== ""
		|| url.password !== ""
		|| url.pathname !== "/"
		|| url.search !== ""
		|| url.hash !== ""
	) {
		throw new Error("Laya base URL must be an HTTP loopback origin on 127.0.0.1 or [::1], with no path or credentials.");
	}
	return url;
}

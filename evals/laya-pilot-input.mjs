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

function normalizeCandidates(rows) {
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
		const jevRank = integer(row.jev_rank, "jev_rank", rowNumber);
		if (relevance < 0 || relevance > 3) throw new Error(`candidate row ${rowNumber}: relevance must be between 0 and 3.`);
		if (jevRank < 1) throw new Error(`candidate row ${rowNumber}: jev_rank must be positive.`);
		const id = `${queryId}\u0000${candidateId}`;
		const rank = `${queryId}\u0000${jevRank}`;
		if (ids.has(id)) throw new Error(`candidate row ${rowNumber}: duplicate candidate_id for query_id.`);
		if (ranks.has(rank)) throw new Error(`candidate row ${rowNumber}: duplicate jev_rank for query_id.`);
		if (queries.has(queryId) && queries.get(queryId) !== query) {
			throw new Error(`candidate row ${rowNumber}: query text differs within query_id.`);
		}
		ids.add(id);
		ranks.add(rank);
		queries.set(queryId, query);
		return { queryId, candidateId, query, title, abstract: abstract.trim(), relevance, jevRank };
	});
}

function mergeJevRanks(labelRows, rankingRows) {
	if (labelRows.length === 0 || rankingRows.length === 0) throw new Error("label and Jev ranking files must both contain rows.");
	if (labelRows.some((row) => String(row.jev_rank ?? "").trim() !== "")) {
		throw new Error("provide Jev ranks inline or in a separate file, not both.");
	}
	const rankMap = new Map();
	for (const [index, row] of rankingRows.entries()) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`Jev row ${index + 1} must be an object.`);
		}
		const queryId = requiredText(row, "query_id", index + 1);
		const candidateId = requiredText(row, "candidate_id", index + 1);
		const rankValue = row.jev_rank ?? row.rank;
		const key = `${queryId}\u0000${candidateId}`;
		if (rankMap.has(key)) throw new Error(`Jev row ${index + 1}: duplicate candidate for query_id.`);
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
		const key = `${queryId}\u0000${candidateId}`;
		labelKeys.add(key);
		if (!rankMap.has(key)) {
			missing += 1;
			return row;
		}
		return { ...row, jev_rank: rankMap.get(key) };
	});
	const extra = [...rankMap.keys()].filter((key) => !labelKeys.has(key)).length;
	if (missing || extra) throw new Error(`label and Jev candidate IDs do not match (missing=${missing}, extra=${extra}).`);
	return joined;
}

export function parseCutoffs(value) {
	const cutoffs = value.split(",").map((part) => Number(part.trim()));
	if (cutoffs.length === 0 || cutoffs.some((cutoff) => !Number.isInteger(cutoff) || cutoff < 1)) {
		throw new Error("cutoffs must be comma-separated positive integers.");
	}
	if (new Set(cutoffs).size !== cutoffs.length) throw new Error("cutoffs must be unique.");
	return cutoffs;
}

export function loadCandidateRows(labelsPath, rankingPath) {
	const resolvedLabelsPath = resolve(labelsPath);
	const labelBytes = readFileSync(resolvedLabelsPath);
	const labelRows = readRows(resolvedLabelsPath);
	const resolvedRankingPath = rankingPath ? resolve(rankingPath) : null;
	const rankingBytes = resolvedRankingPath ? readFileSync(resolvedRankingPath) : null;
	const rows = resolvedRankingPath
		? mergeJevRanks(labelRows, readRows(resolvedRankingPath))
		: labelRows;
	return {
		rows: normalizeCandidates(rows),
		label: {
			name: basename(resolvedLabelsPath),
			sha256: createHash("sha256").update(labelBytes).digest("hex"),
		},
		jev: resolvedRankingPath
			? {
					name: basename(resolvedRankingPath),
					sha256: createHash("sha256").update(rankingBytes).digest("hex"),
				}
			: "inline",
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

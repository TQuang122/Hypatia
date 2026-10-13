import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DOUBLE_LABEL_SEED = "hypatia-laya-double-label-v1";

function readJsonl(path) {
	const name = path.split(/[\\/]/u).at(-1);
	return readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line, index) => {
		if (!line.trim()) return [];
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`${name} contains invalid JSON at line ${index + 1}.`);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${name} line ${index + 1} must contain an object.`);
		}
		return [value];
	});
}

function text(row, field, label, index) {
	const value = row[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} row ${index + 1}: ${field} must be a non-empty string.`);
	}
	return value.trim();
}

function key(queryId, candidateId) {
	return JSON.stringify([queryId, candidateId]);
}

function validatePool(pool, label) {
	if (!Array.isArray(pool.labels) || pool.labels.length === 0) {
		throw new Error(`${label} label pool must contain candidates.`);
	}
	if (!Array.isArray(pool.rankings) || pool.rankings.length === 0) {
		throw new Error(`${label} rank pool must contain candidates.`);
	}

	const candidateKeys = new Set();
	const queryTexts = new Map();
	const queryCounts = new Map();
	const sourceCounts = new Map();
	let titleOnlyCandidates = 0;
	for (const [index, row] of pool.labels.entries()) {
		if (row.relevance !== null) throw new Error(`${label} label row ${index + 1}: relevance must remain null for blind annotation.`);
		const queryId = text(row, "query_id", `${label} label`, index);
		const candidateId = text(row, "candidate_id", `${label} label`, index);
		const query = text(row, "query", `${label} label`, index);
		text(row, "title", `${label} label`, index);
		if (typeof row.abstract !== "string") throw new Error(`${label} label row ${index + 1}: abstract must be a string.`);
		if (queryTexts.has(queryId) && queryTexts.get(queryId) !== query) {
			throw new Error(`${label} label row ${index + 1}: query text differs within query_id.`);
		}
		const pair = key(queryId, candidateId);
		if (candidateKeys.has(pair)) throw new Error(`${label} label row ${index + 1}: duplicate candidate for query_id.`);
		candidateKeys.add(pair);
		queryTexts.set(queryId, query);
		queryCounts.set(queryId, (queryCounts.get(queryId) ?? 0) + 1);
		if (row.abstract.trim() === "") titleOnlyCandidates += 1;
		const source = typeof row.retrieval_source === "string" && row.retrieval_source.trim()
			? row.retrieval_source.trim()
			: "unknown";
		sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
	}

	const rankKeys = new Set();
	const ranksByQuery = new Set();
	for (const [index, row] of pool.rankings.entries()) {
		const queryId = text(row, "query_id", `${label} rank`, index);
		const candidateId = text(row, "candidate_id", `${label} rank`, index);
		const pair = key(queryId, candidateId);
		if (rankKeys.has(pair)) throw new Error(`${label} rank row ${index + 1}: duplicate candidate for query_id.`);
		rankKeys.add(pair);
		if (!Number.isInteger(row.baseline_rank) || row.baseline_rank < 1) {
			throw new Error(`${label} rank row ${index + 1}: baseline_rank must be a positive integer.`);
		}
		const queryRank = key(queryId, String(row.baseline_rank));
		if (ranksByQuery.has(queryRank)) throw new Error(`${label} rank row ${index + 1}: duplicate baseline_rank for query_id.`);
		ranksByQuery.add(queryRank);
	}

	const missingRanks = [...candidateKeys].filter((candidateKey) => !rankKeys.has(candidateKey));
	const extraRanks = [...rankKeys].filter((candidateKey) => !candidateKeys.has(candidateKey));
	if (missingRanks.length || extraRanks.length) {
		throw new Error(`${label} label and rank candidate IDs do not match (missing=${missingRanks.length}, extra=${extraRanks.length}).`);
	}
	return {
		queryIds: [...queryTexts.keys()].toSorted(),
		queryCounts,
		candidates: pool.labels.length,
		titleOnlyCandidates,
		sourceCounts,
	};
}

export function mergeBlindedCandidatePools(existingPool, additionalPool) {
	const existing = validatePool(existingPool, "existing");
	const additional = validatePool(additionalPool, "additional");
	const overlap = existing.queryIds.filter((queryId) => additional.queryIds.includes(queryId));
	if (overlap.length > 0) throw new Error(`existing and additional query IDs overlap: ${overlap.join(", ")}.`);
	const labels = [...existingPool.labels, ...additionalPool.labels];
	const rankings = [...existingPool.rankings, ...additionalPool.rankings];
	const groups = new Map();
	for (const row of labels) {
		const group = groups.get(row.query_id) ?? [];
		group.push(row);
		groups.set(row.query_id, group);
	}
	const doubleLabelRows = [];
	const doubleLabelPerQuery = {};
	for (const [queryId, rows] of [...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
		const sampleCount = Math.ceil(rows.length * 0.2);
		const selected = rows
			.map((row) => ({
				row,
				hash: createHash("sha256")
					.update(`${DOUBLE_LABEL_SEED}\0${row.query_id}\0${row.candidate_id}`)
					.digest("hex"),
			}))
			.toSorted((left, right) => left.hash.localeCompare(right.hash))
			.slice(0, sampleCount)
			.map(({ row }) => row);
		doubleLabelRows.push(...selected);
		doubleLabelPerQuery[queryId] = selected.length;
	}
	doubleLabelRows.sort((left, right) => {
		const leftHash = createHash("sha256").update(`${DOUBLE_LABEL_SEED}\0${left.query_id}\0${left.candidate_id}`).digest("hex");
		const rightHash = createHash("sha256").update(`${DOUBLE_LABEL_SEED}\0${right.query_id}\0${right.candidate_id}`).digest("hex");
		return leftHash.localeCompare(rightHash);
	});
	const queryCounts = new Map([...existing.queryCounts, ...additional.queryCounts]);
	const sourceCounts = new Map(existing.sourceCounts);
	for (const [source, count] of additional.sourceCounts) {
		sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + count);
	}
	return {
		labels,
		rankings,
		doubleLabels: doubleLabelRows,
		summary: {
			labelStatus: "all relevance values are null; ready for blind human annotation",
			queryIds: [...existing.queryIds, ...additional.queryIds].toSorted(),
			queries: existing.queryIds.length + additional.queryIds.length,
			candidates: labels.length,
			candidatesPerQuery: Object.fromEntries([...queryCounts.entries()].toSorted(([left], [right]) => left.localeCompare(right))),
			titleOnlyCandidates: existing.titleOnlyCandidates + additional.titleOnlyCandidates,
			abstractCandidates: labels.length - existing.titleOnlyCandidates - additional.titleOnlyCandidates,
			sourceCounts: Object.fromEntries([...sourceCounts.entries()].toSorted(([left], [right]) => left.localeCompare(right))),
			doubleLabelPlan: {
				seed: DOUBLE_LABEL_SEED,
				targetFraction: 0.2,
				candidates: doubleLabelRows.length,
				perQuery: doubleLabelPerQuery,
			},
		},
	};
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function jsonl(rows) {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function requiredPath(value, name) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required.`);
	return resolve(value);
}

async function main() {
	const { values } = parseArgs({
		options: {
			"existing-labels": { type: "string", default: "outputs/decision-model-systems-hypatia-heldout-labels.jsonl" },
			"existing-rankings": { type: "string", default: "outputs/decision-model-systems-hypatia-heldout-ranks.jsonl" },
			"additional-labels": { type: "string" },
			"additional-rankings": { type: "string" },
			"labels-output": { type: "string", default: "outputs/laya-hypatia-30-labels.jsonl" },
			"double-labels-output": { type: "string", default: "outputs/laya-hypatia-30-double-labels.jsonl" },
			"rankings-output": { type: "string", default: "outputs/laya-hypatia-30-ranks.jsonl" },
			"summary-output": { type: "string", default: "outputs/laya-hypatia-30-pool-summary.json" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"Usage: node evals/merge-hypatia-laya-pools.mjs --additional-labels <jsonl> " +
			"--additional-rankings <jsonl> [--existing-labels <jsonl>] " +
			"[--existing-rankings <jsonl>] [--labels-output <jsonl>] " +
			"[--double-labels-output <jsonl>] [--rankings-output <jsonl>] [--summary-output <json>]\n",
		);
		return;
	}
	const existingLabelsPath = requiredPath(values["existing-labels"], "existing-labels");
	const existingRankingsPath = requiredPath(values["existing-rankings"], "existing-rankings");
	const additionalLabelsPath = requiredPath(values["additional-labels"], "additional-labels");
	const additionalRankingsPath = requiredPath(values["additional-rankings"], "additional-rankings");
	const outputPaths = {
		labels: requiredPath(values["labels-output"], "labels-output"),
		doubleLabels: requiredPath(values["double-labels-output"], "double-labels-output"),
		rankings: requiredPath(values["rankings-output"], "rankings-output"),
		summary: requiredPath(values["summary-output"], "summary-output"),
	};
	const inputPaths = [existingLabelsPath, existingRankingsPath, additionalLabelsPath, additionalRankingsPath];
	if (new Set([...inputPaths, ...Object.values(outputPaths)]).size !== inputPaths.length + Object.values(outputPaths).length) {
		throw new Error("Input and output paths must all be distinct.");
	}
	if (new Set(Object.values(outputPaths)).size !== Object.values(outputPaths).length) {
		throw new Error("Output paths must be distinct.");
	}
	if (Object.values(outputPaths).some(existsSync)) throw new Error("Choose output paths that do not already exist.");

	const existingLabelsText = readFileSync(existingLabelsPath, "utf8");
	const existingRankingsText = readFileSync(existingRankingsPath, "utf8");
	const additionalLabelsText = readFileSync(additionalLabelsPath, "utf8");
	const additionalRankingsText = readFileSync(additionalRankingsPath, "utf8");
	const merged = mergeBlindedCandidatePools(
		{ labels: readJsonl(existingLabelsPath), rankings: readJsonl(existingRankingsPath) },
		{ labels: readJsonl(additionalLabelsPath), rankings: readJsonl(additionalRankingsPath) },
	);
	const labelsText = jsonl(merged.labels);
	const doubleLabelsText = jsonl(merged.doubleLabels);
	const rankingsText = jsonl(merged.rankings);
	const summary = {
		...merged.summary,
		inputs: {
			existingLabels: { path: existingLabelsPath, sha256: sha256(existingLabelsText) },
			existingRankings: { path: existingRankingsPath, sha256: sha256(existingRankingsText) },
			additionalLabels: { path: additionalLabelsPath, sha256: sha256(additionalLabelsText) },
			additionalRankings: { path: additionalRankingsPath, sha256: sha256(additionalRankingsText) },
		},
		outputs: {
			labels: { path: outputPaths.labels, sha256: sha256(labelsText) },
			doubleLabels: { path: outputPaths.doubleLabels, sha256: sha256(doubleLabelsText) },
			rankings: { path: outputPaths.rankings, sha256: sha256(rankingsText) },
		},
	};
	const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
	for (const path of Object.values(outputPaths)) mkdirSync(dirname(path), { recursive: true });
	const created = [];
	try {
		writeFileSync(outputPaths.labels, labelsText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.labels);
		writeFileSync(outputPaths.doubleLabels, doubleLabelsText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.doubleLabels);
		writeFileSync(outputPaths.rankings, rankingsText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.rankings);
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
		process.stderr.write(`Hypatia Laya pool merge failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

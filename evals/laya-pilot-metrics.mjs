import { USEFUL_RELEVANCE_MINIMUM } from "./laya-pilot-input.mjs";

function queryMetrics(rows, order, cutoffs) {
	const relevantTotal = rows.filter((row) => row.relevance > 0).length;
	const firstRelevant = order.findIndex((row) => row.relevance > 0);
	const metrics = { mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1) };
	for (const cutoff of cutoffs) {
		const top = order.slice(0, cutoff);
		const hits = top.filter((row) => row.relevance > 0).length;
		metrics[`precision@${cutoff}`] = hits / Math.min(cutoff, rows.length);
		metrics[`recall@${cutoff}`] = relevantTotal === 0 ? 0 : hits / relevantTotal;
		const dcg = top.reduce((sum, row, index) => sum + (2 ** row.relevance - 1) / Math.log2(index + 2), 0);
		const ideal = rows.map((row) => row.relevance).sort((left, right) => right - left).slice(0, cutoff);
		const idcg = ideal.reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0);
		metrics[`ndcg@${cutoff}`] = idcg === 0 ? 0 : dcg / idcg;
	}
	return metrics;
}

function macroAverage(perQuery) {
	const names = Object.keys(perQuery[0]);
	return Object.fromEntries(names.map((name) => [
		name,
		perQuery.reduce((sum, metrics) => sum + metrics[name], 0) / perQuery.length,
	]));
}

function classificationMetrics(rows) {
	let truePositive = 0;
	let falsePositive = 0;
	let trueNegative = 0;
	let falseNegative = 0;
	let brier = 0;
	for (const row of rows) {
		const actual = row.relevance >= USEFUL_RELEVANCE_MINIMUM;
		const predicted = row.layaChoice === "A";
		if (actual && predicted) truePositive += 1;
		else if (predicted) falsePositive += 1;
		else if (actual) falseNegative += 1;
		else trueNegative += 1;
		brier += (row.layaScore - Number(actual)) ** 2;
	}
	const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
	const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
	return {
		accuracy: (truePositive + trueNegative) / rows.length,
		precision,
		recall,
		f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
		brier: brier / rows.length,
	};
}

export function pairedQueryBootstrap(perQuery, baselineKey, metric, { iterations = 10_000, seed = 20261011 } = {}) {
	if (!Array.isArray(perQuery) || perQuery.length === 0) throw new Error("bootstrap requires at least one query.");
	if (!Number.isInteger(iterations) || iterations < 1) throw new Error("bootstrap iterations must be a positive integer.");
	if (!Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) throw new Error("bootstrap seed must be a positive 32-bit integer.");
	const differences = perQuery.map((row, index) => {
		const laya = row?.laya?.[metric];
		const baseline = row?.[baselineKey]?.[metric];
		if (typeof laya !== "number" || !Number.isFinite(laya) || typeof baseline !== "number" || !Number.isFinite(baseline)) {
			throw new Error(`bootstrap query ${index + 1} is missing metric ${metric}.`);
		}
		return laya - baseline;
	});
	const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
	const samples = new Array(iterations);
	let state = seed >>> 0;
	for (let sample = 0; sample < iterations; sample += 1) {
		let sum = 0;
		for (let query = 0; query < differences.length; query += 1) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			const selected = Math.floor((state / 0x1_0000_0000) * differences.length);
			sum += differences[selected] ?? 0;
		}
		samples[sample] = sum / differences.length;
	}
	samples.sort((left, right) => left - right);
	const percentile = (probability) => samples[Math.max(0, Math.ceil(probability * iterations) - 1)] ?? 0;
	return {
		baselineKey,
		metric,
		confidenceLevel: 0.95,
		iterations,
		seed,
		meanDifference,
		lower: percentile(0.025),
		upper: percentile(0.975),
	};
}

export function summarizeLatencyTrials(trials, candidateCount) {
	if (!Array.isArray(trials) || trials.length === 0) throw new Error("latency summary requires at least one warm trial.");
	if (!Number.isInteger(candidateCount) || candidateCount < 1) throw new Error("candidate count must be a positive integer.");
	let scoredCandidates = 0;
	let truncatedCandidates = 0;
	let successfulRequests = 0;
	for (const [index, trial] of trials.entries()) {
		if (typeof trial?.durationMs !== "number" || !Number.isFinite(trial.durationMs) || trial.durationMs < 0) {
			throw new Error(`latency trial ${index + 1} has an invalid duration.`);
		}
		const scored = trial.state === "advisory" ? trial.scoredCandidates : 0;
		const truncated = trial.state === "advisory" ? trial.truncatedCandidates : 0;
		if (!Number.isInteger(scored) || scored < 0 || scored > candidateCount) {
			throw new Error(`latency trial ${index + 1} has an invalid scored-candidate count.`);
		}
		if (!Number.isInteger(truncated) || truncated < 0 || truncated > scored) {
			throw new Error(`latency trial ${index + 1} has an invalid truncation count.`);
		}
		if (trial.state === "advisory") successfulRequests += 1;
		scoredCandidates += scored;
		truncatedCandidates += truncated;
	}
	const durations = trials.map((trial) => trial.durationMs).toSorted((left, right) => left - right);
	const p95Index = Math.max(0, Math.ceil(0.95 * durations.length) - 1);
	return {
		warmRequests: trials.length,
		successfulRequests,
		failedRequests: trials.length - successfulRequests,
		candidateAttempts: trials.length * candidateCount,
		scoredCandidates,
		candidateSuccessRate: scoredCandidates / (trials.length * candidateCount),
		truncatedCandidates,
		truncationRate: scoredCandidates === 0 ? null : truncatedCandidates / scoredCandidates,
		warmP95Ms: durations[p95Index] ?? 0,
		warmMaxMs: durations.at(-1) ?? 0,
	};
}

function rankingSummary(rows, cutoffs, baselineName) {
	const rankField = baselineName === null ? "jevRank" : "baselineRank";
	const baselineKey = baselineName === null ? "jev" : "baseline";
	const groups = new Map();
	for (const row of rows) {
		const group = groups.get(row.queryId) ?? [];
		group.push(row);
		groups.set(row.queryId, group);
	}
	const perQuery = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([queryId, group]) => {
		const laya = [...group].sort((left, right) => right.layaScore - left.layaScore || left[rankField] - right[rankField]);
		const baseline = [...group].sort((left, right) => left[rankField] - right[rankField]);
		return {
			queryId,
			laya: queryMetrics(group, laya, cutoffs),
			[baselineKey]: queryMetrics(group, baseline, cutoffs),
		};
	});
	const baselineMetrics = perQuery.length ? macroAverage(perQuery.map((row) => row[baselineKey])) : {};
	return {
		queries: groups.size,
		candidates: rows.length,
		relevantCandidates: rows.filter((row) => row.relevance > 0).length,
		laya: perQuery.length ? macroAverage(perQuery.map((row) => row.laya)) : {},
		[baselineKey]: baselineName === null
			? baselineMetrics
			: { name: baselineName, ...baselineMetrics },
		perQuery,
	};
}

function withoutPerQuery(summary) {
	return Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "perQuery"));
}

export function evaluateRankings(rows, cutoffs, baselineName = null) {
	const summary = rankingSummary(rows, cutoffs, baselineName);
	const abstractPresent = rankingSummary(rows.filter((row) => typeof row.abstract === "string" && row.abstract.trim() !== ""), cutoffs, baselineName);
	const titleOnly = rankingSummary(rows.filter((row) => typeof row.abstract !== "string" || row.abstract.trim() === ""), cutoffs, baselineName);
	const baselineKey = baselineName === null ? "jev" : "baseline";
	return {
		...summary,
		laya: {
			...summary.laya,
			classification: classificationMetrics(rows),
		},
		abstractStrata: {
			abstractPresent: withoutPerQuery(abstractPresent),
			titleOnly: withoutPerQuery(titleOnly),
		},
		...(cutoffs.includes(10) ? { pairedBootstrap: pairedQueryBootstrap(summary.perQuery, baselineKey, "ndcg@10") } : {}),
		truncatedCandidates: rows.filter((row) => row.layaTruncated).map((row) => row.candidateId),
	};
}

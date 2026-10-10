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
		const actual = row.relevance > 0;
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

export function evaluateRankings(rows, cutoffs) {
	const groups = new Map();
	for (const row of rows) {
		const group = groups.get(row.queryId) ?? [];
		group.push(row);
		groups.set(row.queryId, group);
	}
	const perQuery = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([queryId, group]) => {
		const laya = [...group].sort((left, right) => right.layaScore - left.layaScore || left.candidateId.localeCompare(right.candidateId));
		const jev = [...group].sort((left, right) => left.jevRank - right.jevRank);
		return {
			queryId,
			laya: queryMetrics(group, laya, cutoffs),
			jev: queryMetrics(group, jev, cutoffs),
		};
	});
	return {
		queries: groups.size,
		candidates: rows.length,
		relevantCandidates: rows.filter((row) => row.relevance > 0).length,
		laya: {
			...macroAverage(perQuery.map((row) => row.laya)),
			classification: classificationMetrics(rows),
		},
		jev: macroAverage(perQuery.map((row) => row.jev)),
		perQuery,
		truncatedCandidates: rows.filter((row) => row.layaTruncated).map((row) => row.candidateId),
	};
}

export type PairedQueryBootstrapQuery = {
	laya: Record<string, number>;
	[key: string]: unknown;
};

export type PairedQueryBootstrapResult = {
	baselineKey: string;
	metric: string;
	confidenceLevel: number;
	iterations: number;
	seed: number;
	meanDifference: number;
	lower: number;
	upper: number;
};

export function pairedQueryBootstrap(
	perQuery: readonly PairedQueryBootstrapQuery[],
	baselineKey: string,
	metric: string,
	options?: { iterations?: number; seed?: number },
): PairedQueryBootstrapResult;

export type LayaLatencyTrial = {
	state: string;
	durationMs: number;
	scoredCandidates?: number;
	truncatedCandidates?: number;
};

export function summarizeLatencyTrials(
	trials: readonly LayaLatencyTrial[],
	candidateCount: number,
): {
	warmRequests: number;
	successfulRequests: number;
	failedRequests: number;
	candidateAttempts: number;
	scoredCandidates: number;
	candidateSuccessRate: number;
	truncatedCandidates: number;
	truncationRate: number | null;
	warmP95Ms: number;
	warmMaxMs: number;
};

export type LayaRankingRow = {
	queryId: string;
	candidateId: string;
	relevance: number;
	layaScore: number;
	layaChoice: "A" | "B";
	abstract?: string;
	layaTruncated?: boolean;
	jevRank?: number;
	baselineRank?: number;
};

export function evaluateRankings(
	rows: readonly LayaRankingRow[],
	cutoffs: readonly number[],
	baselineName?: string | null,
): Record<string, unknown>;

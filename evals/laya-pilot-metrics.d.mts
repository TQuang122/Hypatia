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

export type LayaRankingRow = {
	queryId: string;
	candidateId: string;
	relevance: number;
	layaScore: number;
	layaChoice: "A" | "B";
	layaTruncated?: boolean;
	jevRank?: number;
	baselineRank?: number;
};

export function evaluateRankings(
	rows: readonly LayaRankingRow[],
	cutoffs: readonly number[],
	baselineName?: string | null,
): Record<string, unknown>;

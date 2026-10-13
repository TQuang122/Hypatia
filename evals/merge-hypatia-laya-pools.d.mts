export type CandidateLabelInput = {
	query_id: string;
	candidate_id: string;
	query: string;
	title: string;
	abstract: string;
	relevance: unknown;
	retrieval_source?: string;
	[key: string]: unknown;
};

export type BlindedCandidateLabel = Omit<CandidateLabelInput, "relevance"> & {
	relevance: null;
};

export type CandidateRanking = {
	query_id: string;
	candidate_id: string;
	baseline_rank: number;
	[key: string]: unknown;
};

export type BlindedCandidatePool = {
	labels: readonly CandidateLabelInput[];
	rankings: readonly CandidateRanking[];
};

export function mergeBlindedCandidatePools(
	existingPool: BlindedCandidatePool,
	additionalPool: BlindedCandidatePool,
): {
	labels: BlindedCandidateLabel[];
	rankings: CandidateRanking[];
	doubleLabels: BlindedCandidateLabel[];
	summary: {
		labelStatus: string;
		queryIds: string[];
		queries: number;
		candidates: number;
		candidatesPerQuery: Record<string, number>;
		titleOnlyCandidates: number;
		abstractCandidates: number;
		sourceCounts: Record<string, number>;
		doubleLabelPlan: {
			seed: string;
			targetFraction: number;
			candidates: number;
			perQuery: Record<string, number>;
		};
	};
};

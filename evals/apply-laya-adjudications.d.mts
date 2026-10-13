export type AdjudicatedLabelInput = {
	query_id: string;
	candidate_id: string;
	query: string;
	title: string;
	abstract: string;
	relevance: number;
	[key: string]: unknown;
};

export type BlindAdjudicationInput = {
	query_id: string;
	candidate_id: string;
	adjudicated_relevance: number;
	confidence: "high" | "medium" | "low";
	rationale: string;
	adjudicator: string;
};

export function applyLayaAdjudications(
	primaryRows: readonly AdjudicatedLabelInput[],
	duplicateRows: readonly AdjudicatedLabelInput[],
	adjudicationRows: readonly BlindAdjudicationInput[],
): {
	rows: AdjudicatedLabelInput[];
	summary: {
		primaryCandidates: number;
		duplicateCandidates: number;
		disagreements: number;
		adjudicatedCandidates: number;
		changedPrimaryGrades: number;
		adjudicators: string[];
		finalGradeCounts: Record<string, number>;
	};
};

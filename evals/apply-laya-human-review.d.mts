export type LayaHumanLabelInput = {
	query_id: string;
	candidate_id: string;
	query: string;
	title: string;
	abstract: string;
	relevance: number;
	[key: string]: unknown;
};

export type LayaHumanReviewInput = {
	query_id: string;
	candidate_id: string;
	query: string;
	title: string;
	primary_relevance: number;
	double_relevance: number;
	final_relevance: number | null;
	reviewer?: "user" | "assistant";
	confidence?: "high" | "medium" | "low";
	evidence_basis?: "title" | "title_abstract";
	rationale?: string;
};

export type LayaHumanReviewMetadata = {
	primary_relevance: number;
	double_relevance: number;
	final_relevance: number;
	reviewer: "user" | "assistant";
	confidence?: "high" | "medium" | "low";
	evidence_basis?: "title" | "title_abstract";
	rationale?: string;
};

export function applyLayaHumanReview(
	baseRows: readonly LayaHumanLabelInput[],
	primaryRows: readonly LayaHumanLabelInput[],
	duplicateRows: readonly LayaHumanLabelInput[],
	reviewRows: readonly LayaHumanReviewInput[],
	options?: { reviewer?: "user" | "assistant" },
): {
	rows: Array<LayaHumanLabelInput & { human_review?: LayaHumanReviewMetadata }>;
	summary: {
		baseCandidates: number;
		primaryCandidates: number;
		duplicateCandidates: number;
		thresholdCrossingDisagreements: number;
		reviewer: "user" | "assistant";
		resolvedCandidates: number;
		changedBaselineGrades: number;
		unchangedBaselineGrades: number;
		finalGradeCounts: Record<string, number>;
	};
};

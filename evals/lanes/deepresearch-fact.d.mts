export type DeepResearchFactJudgment = {
	result: "supported" | "unsupported" | "unknown";
};

export type DeepResearchFactCitation = {
	validate_error: string | null;
	validate_res: DeepResearchFactJudgment[];
};

export type DeepResearchFactRow = {
	id: string;
	model: string;
	role?: string;
	citations: unknown[];
	citations_deduped: Record<string, DeepResearchFactCitation>;
};

export type DeepResearchFactGroup = {
	model: string;
	role: string;
	reports: number;
	reports_with_citations: number;
	supported_claims: number;
	unsupported_claims: number;
	unknown_claims: number;
	validation_errors: number;
	citation_accuracy: number | null;
	effective_citations_per_task: number;
	official_style_effective_citations_per_cited_report: number | null;
};

export type DeepResearchFactSummary = {
	benchmark: "DeepResearch Bench FACT";
	evaluator_revision: string;
	dataset_revision: string;
	evaluator: string;
	groups: DeepResearchFactGroup[];
};

export function scoreDeepResearchFactRows(rows: readonly DeepResearchFactRow[]): DeepResearchFactSummary;

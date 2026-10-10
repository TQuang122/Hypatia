export type AstaBenchScores = {
	ingredient_recall: number;
	answer_precision: number;
	citation_precision: number;
	citation_recall: number;
};

export type AstaBenchScoreRow = {
	id: string;
	model: string;
	role?: string;
	scores: AstaBenchScores;
};

export type AstaBenchGroupScore = AstaBenchScores & {
	model: string;
	role: string;
	samples: number;
	citation_f1: number;
	global_avg: number;
};

export type AstaBenchSummary = {
	benchmark: "ScholarQA-CS2";
	config: "AstaBench v1.0.0";
	evaluator_revision: string;
	dataset_revision: string;
	split: "ScholarQA_CS2_validation" | "ScholarQA_CS2_test";
	judge: string;
	groups: AstaBenchGroupScore[];
};

export function scoreAstaBenchRows(
	rows: readonly AstaBenchScoreRow[],
	options?: { split?: "validation" | "test" },
): AstaBenchSummary;

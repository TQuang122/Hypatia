export type LayaCandidateRow = {
	queryId: string;
	candidateId: string;
	query: string;
	title?: string;
	abstract: string;
	relevance: number;
	jevRank?: number;
	baselineRank?: number;
};

export type LayaLabelSummary = {
	candidates: number;
	queries: number;
	relevantCandidates: number;
	nonRelevantCandidates: number;
	answerUsefulCandidates: number;
	notUsefulCandidates: number;
	relevanceGrades: Record<0 | 1 | 2 | 3, number>;
	titleOnlyCandidates: number;
	abstractCandidates: number;
};

export const USEFUL_RELEVANCE_MINIMUM: number;

export function balanceTrainingRows(
	rows: readonly LayaCandidateRow[],
	options?: { seed?: string },
): {
	rows: LayaCandidateRow[];
	before: LayaLabelSummary;
	after: LayaLabelSummary;
	omittedCandidates: number;
};

export function splitRowsByQuery(
	rows: readonly LayaCandidateRow[],
	options: { testQueryIds: readonly string[] },
): {
	trainQueryIds: string[];
	testQueryIds: string[];
	trainRows: LayaCandidateRow[];
	testRows: LayaCandidateRow[];
	trainSummary: LayaLabelSummary;
	testSummary: LayaLabelSummary;
};

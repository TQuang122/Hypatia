export type SciCoqaJudgeRow = {
	model: string;
	role?: string;
	discrepancy_id: string;
	origin: "real" | "synthetic";
	code_only: boolean;
	eval_type: string;
	answer: "yes" | "no";
	reference_available?: boolean;
};

export type SciCoqaRecallGroup = {
	model: string;
	role: string;
	denominator: 92;
	evaluated_discrepancies: number;
	recalled_discrepancies: number;
	recall: number;
};

export type SciCoqaSummary = {
	benchmark: "SciCoQA";
	dataset_version: "v1.1";
	code_revision: string;
	dataset_revision: string;
	split: "real";
	denominator: 92;
	matching: string;
	groups: SciCoqaRecallGroup[];
};

export function scoreSciCoqaRows(
	rows: readonly SciCoqaJudgeRow[],
	realDiscrepancyIds: readonly string[],
	options?: { evalType?: string },
): SciCoqaSummary;

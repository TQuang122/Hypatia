import type { LayaCandidateRow, LayaLabelSummary } from "./laya-pilot-input.mjs";

export type LayaTrainingCase = {
	state: string;
	questions: {
		relevance: {
			type: "choice";
			instructions: string;
			criteria: { A: string; B: string };
		};
	};
	expected: { relevance: "A" | "B" };
};

export type LayaTrainingDataSummary = {
	seed: string;
	binaryDecision: { usefulWhen: string; notUsefulWhen: string };
	train: {
		queryIds: string[];
		selectedQueryIds: string[];
		candidatesBeforeBalance: number;
		candidatesAfterBalance: number;
		omittedCandidates: number;
		balance: { before: LayaLabelSummary; after: LayaLabelSummary };
	};
	holdout: LayaLabelSummary & { queryIds: string[] };
};

export type LayaTrainingOnlyDataSummary = Omit<LayaTrainingDataSummary, "holdout"> & {
	scope: string;
	holdout: null;
};

export function prepareLayaTrainingData(
	trainRows: readonly LayaCandidateRow[],
	holdoutRows: readonly LayaCandidateRow[],
	options?: { seed?: string },
): {
	train: LayaTrainingCase[];
	holdout: LayaTrainingCase[];
	summary: LayaTrainingDataSummary;
};

export function prepareLayaTrainingOnlyData(
	rows: readonly LayaCandidateRow[],
	options?: { seed?: string },
): {
	train: LayaTrainingCase[];
	summary: LayaTrainingOnlyDataSummary;
};

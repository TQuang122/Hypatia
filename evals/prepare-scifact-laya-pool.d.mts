export function rankBm25Candidates(
	query: string,
	corpus: Record<string, unknown>[],
	limit?: number,
): Array<{ docId: string; title: string; abstract: string; score: number }>;

export function selectScifactDevClaims(
	claims: Record<string, unknown>[],
	options: { count: number; excludedIds?: Set<string>; seed?: string },
): Record<string, unknown>[];

export function buildScifactRows(
	claim: Record<string, unknown>,
	candidates: Array<{ docId: string; title: string; abstract: string; score: number }>,
): { labels: Record<string, unknown>[]; rankings: Record<string, unknown>[] };

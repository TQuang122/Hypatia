export function buildCandidatePoolRows(input: {
	queryId: string;
	query: string;
	searchQuery?: string;
	response: Record<string, unknown>;
}): {
	labels: Record<string, unknown>[];
	rankings: Record<string, unknown>[];
	skipped: number;
};
export function parseQueryOverrides(text: string, selectedIds: Set<string>): Map<string, string>;
export function parseQueryManifest(text: string): Map<string, string>;

const selections = new Map<string, { models: string[]; expiresAt: number }>();
const SELECTION_TTL_MS = 30 * 60 * 1000;

function pruneExpiredSelections(now = Date.now()): void {
	for (const [sessionId, selection] of selections) {
		if (selection.expiresAt <= now) selections.delete(sessionId);
	}
}

export function setIdeaForgeModelSelection(sessionId: string, models: readonly string[]): void {
	pruneExpiredSelections();
	selections.set(sessionId, { models: [...models], expiresAt: Date.now() + SELECTION_TTL_MS });
}

export function getIdeaForgeModelSelection(sessionId: string): string[] | undefined {
	pruneExpiredSelections();
	const selection = selections.get(sessionId);
	return selection ? [...selection.models] : undefined;
}

export function clearIdeaForgeModelSelection(sessionId: string): void {
	selections.delete(sessionId);
}

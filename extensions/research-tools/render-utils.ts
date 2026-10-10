export function formatToolDuration(durationMs: number | undefined): string | undefined {
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
	if (durationMs < 1_000) {
		const roundedMs = Math.round(durationMs);
		return roundedMs < 1_000 ? `${roundedMs}ms` : "1.0s";
	}

	const totalSeconds = Math.round(durationMs / 1_000);
	if (totalSeconds < 60) return `${(Math.round(durationMs / 100) / 10).toFixed(1)}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

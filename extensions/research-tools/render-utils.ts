import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export type ToolSummaryRow = { color: ThemeColor; text: string };

export class ToolSummary implements Component {
	constructor(private readonly rows: ToolSummaryRow[], private readonly theme: Theme) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (width <= 0) return [];
		return this.rows.map((row) => truncateToWidth(this.theme.fg(row.color, row.text), width, width > 1 ? "…" : ""));
	}
}

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

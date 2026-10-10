import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

import {
	compareProvenanceRecords,
	discoverProvenanceRecords,
	type ProvenanceRecord,
	type ProvenanceVerification,
} from "./research-tools/provenance-review.js";

const VERIFICATION_COLORS = {
	PASS: "success",
	"PASS WITH NOTES": "warning",
	BLOCKED: "error",
	UNKNOWN: "dim",
} satisfies Record<ProvenanceVerification, ThemeColor>;

type ComparisonTheme = Pick<Theme, "fg" | "bold">;
type ComparisonTui = Pick<TUI, "requestRender">;

function oneLine(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
}

function displayValue(value: string | undefined): string {
	return oneLine(value ?? "") || "not reported";
}

function padCell(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, width > 1 ? "…" : "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function statusLabel(record: ProvenanceRecord, theme: ComparisonTheme): string {
	return theme.fg(VERIFICATION_COLORS[record.verification], record.verification);
}

function renderComparisonRows(
	differences: ReturnType<typeof compareProvenanceRecords>,
	width: number,
	theme: ComparisonTheme,
): string[] {
	if (differences.length === 0) {
		return [
			theme.fg("success", "No tracked provenance fields differ."),
			theme.fg("dim", "Artifact titles and paths are not compared."),
		];
	}

	if (width >= 76) {
		const fieldWidth = Math.min(20, Math.max(12, Math.floor(width * 0.25)));
		const valueWidth = Math.max(1, Math.floor((width - fieldWidth - 6) / 2));
		const rows = [
			`${padCell(theme.fg("dim", "Field"), fieldWidth)} ${theme.fg("border", "│")} ${padCell(theme.fg("dim", "Baseline"), valueWidth)} ${theme.fg("border", "│")} ${padCell(theme.fg("dim", "Comparison"), valueWidth)}`,
		];

		for (const difference of differences) {
			const fieldLines = wrapTextWithAnsi(difference.field, fieldWidth);
			const beforeLines = wrapTextWithAnsi(displayValue(difference.before), valueWidth);
			const afterLines = wrapTextWithAnsi(displayValue(difference.after), valueWidth);
			const rowCount = Math.max(fieldLines.length, beforeLines.length, afterLines.length);
			for (let index = 0; index < rowCount; index += 1) {
				const field = index === 0 ? theme.fg("accent", fieldLines[index] ?? "") : "";
				const before = theme.fg("dim", beforeLines[index] ?? "");
				const after = theme.fg("text", afterLines[index] ?? "");
				rows.push(
					`${padCell(field, fieldWidth)} ${theme.fg("border", "│")} ${padCell(before, valueWidth)} ${theme.fg("border", "│")} ${padCell(after, valueWidth)}`,
				);
			}
			rows.push("");
		}
		return rows;
	}

	const rows: string[] = [];
	for (const difference of differences) {
		rows.push(theme.fg("accent", theme.bold(difference.field)));
		rows.push(...wrapTextWithAnsi(`${theme.fg("dim", "Baseline")}: ${displayValue(difference.before)}`, width));
		rows.push(...wrapTextWithAnsi(`${theme.fg("text", "Comparison")}: ${displayValue(difference.after)}`, width));
		rows.push("");
	}
	return rows;
}

export class ProvenanceComparisonView implements Component {
	private scrollTop = 0;
	private maxScroll = 0;
	private readonly differences: ReturnType<typeof compareProvenanceRecords>;

	constructor(
		private readonly tui: ComparisonTui,
		private readonly theme: ComparisonTheme,
		private readonly baseline: ProvenanceRecord,
		private readonly comparison: ProvenanceRecord,
		private readonly done: () => void,
	) {
		this.differences = compareProvenanceRecords(baseline, comparison);
	}

	render(width: number): string[] {
		const lineWidth = Math.floor(width);
		if (lineWidth < 6) {
			return [truncateToWidth("Provenance comparison", Math.max(1, lineWidth), "…")];
		}

		const contentWidth = lineWidth - 4;
		const body = renderComparisonRows(this.differences, contentWidth, this.theme);
		const visibleBodyLines = 10;
		this.maxScroll = Math.max(0, body.length - visibleBodyLines);
		this.scrollTop = Math.min(this.scrollTop, this.maxScroll);

		const border = this.theme.fg("border", "│");
		const frameRow = (content: string): string => {
			const clipped = truncateToWidth(content, contentWidth, contentWidth > 1 ? "…" : "");
			return `${border} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${border}`;
		};
		const top = this.theme.fg("border", `┌${"─".repeat(lineWidth - 2)}┐`);
		const bottom = this.theme.fg("border", `└${"─".repeat(lineWidth - 2)}┘`);
		const title = this.theme.fg("accent", this.theme.bold("Provenance comparison"));
		const paths = contentWidth >= 76
			? [`Baseline: ${oneLine(this.baseline.path)}  ·  Comparison: ${oneLine(this.comparison.path)}`]
			: [
				`Baseline: ${truncateToWidth(oneLine(this.baseline.path), Math.max(1, contentWidth - visibleWidth("Baseline: ")), "…")}`,
				`Comparison: ${truncateToWidth(oneLine(this.comparison.path), Math.max(1, contentWidth - visibleWidth("Comparison: ")), "…")}`,
			];
		const verification = `Verification: ${statusLabel(this.baseline, this.theme)} → ${statusLabel(this.comparison, this.theme)}`;
		const visibleEnd = Math.min(body.length, this.scrollTop + visibleBodyLines);
		const scrollLabel = body.length > visibleBodyLines
			? `Lines ${this.scrollTop + 1}-${visibleEnd} of ${body.length}`
			: `${body.length} comparison rows`;
		const controls = contentWidth >= 37
			? "↑↓/PgUp/PgDn scroll · Enter/Esc close"
			: "Enter/Esc close";
		const footer = body.length > visibleBodyLines && contentWidth >= 76
			? `${controls} · ${scrollLabel}`
			: controls;

		return [
			top,
			frameRow(title),
			...paths.map(frameRow),
			frameRow(verification),
			frameRow(""),
			...body.slice(this.scrollTop, visibleEnd).map(frameRow),
			frameRow(""),
			frameRow(this.theme.fg("dim", footer)),
			bottom,
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape")
			|| matchesKey(data, "ctrl+c")
			|| matchesKey(data, "enter")
			|| matchesKey(data, "return")
		) {
			this.done();
			return;
		}

		const page = 8;
		if (matchesKey(data, "up")) this.scrollTop = Math.max(0, this.scrollTop - 1);
		else if (matchesKey(data, "down")) this.scrollTop = Math.min(this.maxScroll, this.scrollTop + 1);
		else if (matchesKey(data, "pageUp")) this.scrollTop = Math.max(0, this.scrollTop - page);
		else if (matchesKey(data, "pageDown")) this.scrollTop = Math.min(this.maxScroll, this.scrollTop + page);
		else return;
		this.tui.requestRender();
	}
}

function selectionLabel(record: ProvenanceRecord): string {
	return `${record.verification} · ${oneLine(record.title)} · ${oneLine(record.path)}`;
}

export function registerProvenanceCompareCommand(pi: ExtensionAPI): void {
	pi.registerCommand("compare-provenance", {
		description: "Compare verification and source-coverage metadata from two completed research runs.",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/compare-provenance requires the interactive TUI.", "warning");
				return;
			}

			const records = await discoverProvenanceRecords(ctx.cwd);
			if (records.length < 2) {
				ctx.ui.notify("Create at least two final provenance sidecars in outputs/ or papers/ to compare runs.", "info");
				return;
			}

			const labels = records.map(selectionLabel);
			const baselineLabel = await ctx.ui.select("Choose baseline provenance", labels);
			if (!baselineLabel) return;
			const baselineIndex = labels.indexOf(baselineLabel);
			const baseline = records[baselineIndex];
			if (!baseline) return;

			const comparisonOptions = records.filter((record) => record.path !== baseline.path);
			const comparisonLabels = comparisonOptions.map(selectionLabel);
			const comparisonLabel = await ctx.ui.select("Choose provenance to compare", comparisonLabels);
			if (!comparisonLabel) return;
			const comparison = comparisonOptions[comparisonLabels.indexOf(comparisonLabel)];
			if (!comparison) return;

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ProvenanceComparisonView(tui, theme, baseline, comparison, () => done(undefined)),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 48, maxHeight: 20, margin: 1 },
				},
			);
		},
	});
}

export default function provenanceCompareExtension(pi: ExtensionAPI): void {
	registerProvenanceCompareCommand(pi);
}

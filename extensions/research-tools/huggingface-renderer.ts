import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatToolDuration, ToolSummary } from "./render-utils.js";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
export type HuggingFaceRenderKind = "dataset-info" | "repo-files" | "read-file";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayText(value: unknown, maxChars = 180): string {
	if (typeof value !== "string") return "";
	const clean = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

function textResult(result: AgentToolResult<unknown>): string {
	return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function repoTypeLabel(value: unknown): string {
	return value === "model" ? "Model" : value === "space" ? "Space" : "Dataset";
}

function countLabel(value: unknown): string | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : undefined;
}

function splitNames(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => displayText(record(item).name, 50)).filter(Boolean);
	if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).map((key) => displayText(key, 50)).filter(Boolean);
	return [];
}

export function createHuggingFaceRenderers(kind: HuggingFaceRenderKind) {
	return {
		renderShell: "default" as const,
		renderCall(args: Record<string, unknown>, theme: Theme): Text {
			const repo = displayText(kind === "dataset-info" ? args.dataset : args.repo, 100);
			const path = kind === "repo-files" || kind === "read-file" ? displayText(args.path, 80) : "";
			const label = kind === "dataset-info" ? "HF dataset" : kind === "repo-files" ? "HF files" : "HF read";
			return new Text(`${theme.fg("toolTitle", theme.bold(label))}${repo ? theme.fg("muted", ` · ${repo}${path ? `/${path}` : ""}`) : ""}`, 0, 0);
		},
		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) {
			if (options.expanded) return new Text(theme.fg(context.isError ? "error" : "toolOutput", textResult(result)), 0, 0);
			const details = record(result.details);
			const args = record(context.args);
			const duration = formatToolDuration(context.durationMs);
			const durationSuffix = duration ? ` · ${duration}` : "";
			if (context.isError) {
				const error = displayText(textResult(result).split(/\r?\n/u).find((line) => line.trim()));
				const label = kind === "dataset-info" ? "HF dataset" : kind === "repo-files" ? "HF files" : "HF read";
				return new ToolSummary([
					{ color: "error", text: `Error · ${label}${durationSuffix}` },
					...(error ? [{ color: "error" as const, text: error }] : []),
					{ color: "dim", text: "Ctrl+O for full error details" },
				], theme);
			}

			const repo = displayText(details.repo ?? details.id ?? args.repo ?? args.dataset, 100);
			const type = repoTypeLabel(details.repoType ?? args.repoType);
			const rows: Array<{ color: "success" | "warning" | "text" | "muted" | "dim"; text: string }> = [];
			if (kind === "dataset-info") {
				const info = record(details.datasetInfo);
				const features = record(info.features);
				const splits = splitNames(info.splits);
				const featureCount = Object.keys(features).length;
				const badges = [details.private === true ? "private" : "", details.gated === true ? "gated" : "", details.disabled === true ? "disabled" : ""].filter(Boolean);
				const counts = [featureCount ? `${featureCount} features` : "", splits.length ? `${splits.length} splits` : ""].filter(Boolean).join(" · ");
				rows.push({ color: details.gated === true || details.private === true ? "warning" : "success", text: `HF ${type.toLowerCase()} · ${repo || "dataset"}${counts ? ` · ${counts}` : ""}${durationSuffix}` });
				if (badges.length) rows.push({ color: "warning", text: badges.join(" · ") });
				if (splits.length) rows.push({ color: "muted", text: `Splits · ${splits.join(", ")}` });
				const popularity = [countLabel(details.downloads) ? `${countLabel(details.downloads)} downloads` : "", countLabel(details.likes) ? `${countLabel(details.likes)} likes` : ""].filter(Boolean).join(" · ");
				if (popularity) rows.push({ color: "muted", text: popularity });
				rows.push({ color: "dim", text: "Ctrl+O for full metadata" });
			} else if (kind === "repo-files") {
				const files = Array.isArray(details.files) ? details.files : [];
				const totalCount = typeof details.count === "number" && Number.isSafeInteger(details.count) && details.count >= 0 ? details.count : files.length;
				const total = countLabel(details.count) ?? String(files.length);
				const shown = files.length;
				const truncated = details.truncated === true;
				rows.push({ color: truncated ? "warning" : "success", text: `HF ${type.toLowerCase()} files · ${repo || "repo"} · ${truncated ? `${shown} of ${total}` : `${total} files`}${durationSuffix}` });
				for (const file of files.slice(0, 2)) {
					const path = displayText(record(file).path ?? record(file).rfilename, 150);
					if (path) rows.push({ color: "text", text: path });
				}
				rows.push({ color: "dim", text: files.length > 2 || truncated ? `+${Math.max(0, totalCount - shown)} more · Ctrl+O for full file list` : "Ctrl+O for full file list" });
			} else {
				const path = displayText(details.path ?? args.path, 100);
				const size = countLabel(details.sizeChars);
				const truncated = details.truncated === true;
				rows.push({ color: truncated ? "warning" : "success", text: `HF file · ${repo || "repo"}/${path || "file"}${size ? ` · ${size} chars` : ""}${durationSuffix}` });
				const preview = typeof details.content === "string" ? displayText(details.content.split(/\r?\n/u).find((line) => line.trim()), 160) : "";
				if (preview) rows.push({ color: "muted", text: preview });
				if (truncated) rows.push({ color: "warning", text: "Content truncated" });
				rows.push({ color: "dim", text: "Ctrl+O for full content" });
			}
			return new ToolSummary(rows, theme);
		},
	};
}

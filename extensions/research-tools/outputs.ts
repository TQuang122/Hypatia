import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import { getExtensionCommandSpec } from "../../metadata/commands.mjs";
import { canPreviewOutput, collectOutputArtifacts, oneLine, OUTPUT_BROWSER_PREVIEW_BYTES, readOutputPreview, relatedOutput, type OutputArtifact, type OutputPreview } from "./output-artifacts.js";
import { OutputBrowserPanel, type OutputBrowserAction, type OutputBrowserState, type OutputBrowserTheme } from "./output-browser.js";
import { OutputReader, type OutputReaderAction, type OutputReaderTheme, type OutputReaderTUI } from "./output-reader.js";

type OutputsOptions = { copyPath?: (text: string) => Promise<void> };
type OutputsUIContext = Pick<ExtensionUIContext, "notify" | "setEditorText" | "custom"> & {
	theme?: OutputReaderTheme & OutputBrowserTheme;
};
export type OutputsCommandContext = Pick<ExtensionCommandContext, "mode" | "hasUI" | "cwd"> & {
	ui: OutputsUIContext;
};

function prefill(ctx: OutputsCommandContext, artifact: OutputArtifact): void {
	ctx.ui.setEditorText(`Read the local file at this exact path: ${JSON.stringify(artifact.path)}.`);
}

async function readBrowserPreview(cwd: string, artifact: OutputArtifact): Promise<OutputPreview> {
	return readOutputPreview(cwd, artifact, { maxBytes: OUTPUT_BROWSER_PREVIEW_BYTES, truncate: true });
}

async function viewOutput(ctx: OutputsCommandContext, selected: OutputArtifact, items: readonly OutputArtifact[], copyPath: (text: string) => Promise<void>): Promise<boolean> {
	let current = selected;
	while (true) {
		const preview = await readOutputPreview(ctx.cwd, current);
		const pair = relatedOutput(current, items);
		const action = await ctx.ui.custom<OutputReaderAction>((tui, theme, _keys, done) => new OutputReader(tui, {
			preview,
			relatedLabel: pair && canPreviewOutput(pair) ? (pair.group === "Provenance" ? "provenance" : "report") : undefined,
			theme: () => ctx.ui.theme ?? theme,
			copyPath: () => copyPath(current.fullPath),
			done,
		}), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
		});
		if (action === "related" && pair && canPreviewOutput(pair)) { current = pair; continue; }
		if (action === "read") { prefill(ctx, current); return true; }
		return false;
	}
}

export async function runOutputsCommand(ctx: OutputsCommandContext, copyPath: (text: string) => Promise<void> = copyToClipboard): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("/outputs requires the interactive TUI.", "warning");
		return;
	}
	const items = await collectOutputArtifacts(ctx.cwd);
	if (!items.length) { ctx.ui.notify("No artifacts found. Use /lit, /draft, /review, or /deepresearch to create some.", "info"); return; }
	const defaultGroup = items.some((item) => item.group === "Reports") ? "Reports" : items[0]!.group;
	let state: OutputBrowserState = { group: defaultGroup, selectedPath: items.find((item) => item.group === defaultGroup)?.path, query: "" };
	while (true) {
		const selected = items.find((item) => item.path === state.selectedPath && item.group === state.group)
			?? items.find((item) => item.group === state.group);
		const initialPreview = selected && canPreviewOutput(selected) ? await readBrowserPreview(ctx.cwd, selected).catch(() => undefined) : undefined;
		const action = await ctx.ui.custom<OutputBrowserAction>((tui, theme, _keys, done) => new OutputBrowserPanel(tui, {
			items,
			state,
			initialPreview,
			loadPreview: (artifact) => readBrowserPreview(ctx.cwd, artifact),
			copyPath,
			theme: () => ctx.ui.theme ?? theme,
			done,
		}), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "96%", maxHeight: "88%", margin: 1 } satisfies OverlayOptions,
		});
		if (!action || action.type === "close") return;
		if (action.type === "read") { prefill(ctx, action.artifact); return; }
		state = action.state;
		try {
			if (await viewOutput(ctx, action.artifact, items, copyPath)) return;
		} catch (error) {
			ctx.ui.notify(oneLine(error instanceof Error ? error.message : String(error)), "warning");
		}
	}
}

export function registerOutputsCommand(pi: Pick<ExtensionAPI, "registerCommand">, options: OutputsOptions = {}): void {
	const copyPath = options.copyPath ?? copyToClipboard;
	pi.registerCommand("outputs", {
		description: getExtensionCommandSpec("outputs")?.description ?? "View research reports and provenance in the TUI, or copy artifact paths.",
		handler: async (_args, ctx) => runOutputsCommand(ctx, copyPath),
	});
}

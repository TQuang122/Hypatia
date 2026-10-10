import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import { getExtensionCommandSpec } from "../../metadata/commands.mjs";
import { OUTPUT_GROUPS, canPreviewOutput, collectOutputArtifacts, oneLine, outputLabel, readOutputPreview, relatedOutput, type OutputArtifact } from "./output-artifacts.js";
import { OutputReader, type OutputReaderAction, type OutputReaderTheme, type OutputReaderTUI } from "./output-reader.js";

type OutputsOptions = { copyPath?: (text: string) => Promise<void> };
type OutputsUIContext = Pick<ExtensionUIContext, "select" | "notify" | "setEditorText"> & {
	theme?: OutputReaderTheme;
	custom<T>(
		factory: (tui: OutputReaderTUI, theme: OutputReaderTheme, keybindings: unknown, done: (result: T) => void) => OutputReader,
		options?: { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions) },
	): Promise<T>;
};
export type OutputsCommandContext = Pick<ExtensionCommandContext, "mode" | "hasUI" | "cwd"> & {
	ui: OutputsUIContext;
};

function prefill(ctx: OutputsCommandContext, artifact: OutputArtifact): void {
	ctx.ui.setEditorText(`Read the local file at this exact path: ${JSON.stringify(artifact.path)}.`);
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
	const groups = OUTPUT_GROUPS.filter((group) => items.some((item) => item.group === group));
	const groupLabels = groups.map((group) => `${group} (${items.filter((item) => item.group === group).length})`);
	while (true) {
		const groupChoice = await ctx.ui.select("Research outputs", groupLabels);
		if (!groupChoice) return;
		const group = groups[groupLabels.indexOf(groupChoice)];
		if (!group) return;
		const groupItems = items.filter((item) => item.group === group);
		const labels = groupItems.map(outputLabel);
		while (true) {
			const choice = await ctx.ui.select(`${group} · newest first`, labels);
			if (!choice) break;
			const selected = groupItems[labels.indexOf(choice)];
			if (!selected) continue;
			if (canPreviewOutput(selected)) {
				try { if (await viewOutput(ctx, selected, items, copyPath)) return; continue; }
				catch (error) { ctx.ui.notify(oneLine(error instanceof Error ? error.message : String(error)), "warning"); }
			}
			const pair = relatedOutput(selected, items);
			const pairAction = pair && canPreviewOutput(pair) ? (pair.group === "Provenance" ? "View provenance" : "View report") : undefined;
			const action = await ctx.ui.select(selected.path, [ ...(pairAction ? [pairAction] : []), "Copy path", "Read in chat", "Back" ]);
			if (action === "Read in chat") { prefill(ctx, selected); return; }
			try {
				if (action === "Copy path") { await copyPath(selected.fullPath); ctx.ui.notify("Path copied", "info"); }
				else if (pairAction && action === pairAction && pair) { if (await viewOutput(ctx, pair, items, copyPath)) return; }
			} catch (error) { ctx.ui.notify(oneLine(error instanceof Error ? error.message : String(error)), "warning"); }
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

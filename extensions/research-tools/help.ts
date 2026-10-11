import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	extensionCommandSpecs,
	formatSlashUsage,
	getExtensionCommandSpec,
	livePackageCommandGroups,
	readPromptSpecs,
} from "../../metadata/commands.mjs";
import { HelpPanel, type HelpPanelCommand } from "./help-panel.js";
import { APP_ROOT } from "./shared.js";

type HelpCommand = { usage: string; description: string; section: string };
type HelpSection = { title: string; commands: HelpCommand[] };

export function buildHelpSections(pi: ExtensionAPI): HelpSection[] {
	const liveCommands = new Map(pi.getCommands().map((command) => [command.name, command]));
	const promptSpecs = readPromptSpecs(APP_ROOT);
	const sections = new Map<string, HelpCommand[]>();

	for (const command of promptSpecs.filter((entry) => entry.section !== "Internal")) {
		const live = liveCommands.get(command.name);
		if (!live) continue;
		const items = sections.get(command.section) ?? [];
		items.push({
			usage: formatSlashUsage(command),
			description: live.description ?? command.description,
			section: command.section,
		});
		sections.set(command.section, items);
	}

	for (const command of extensionCommandSpecs.filter((entry) => entry.publicDocs)) {
		const live = liveCommands.get(command.name);
		if (!live) continue;
		const items = sections.get(command.section) ?? [];
		items.push({
			usage: formatSlashUsage(command),
			description: live.description ?? command.description,
			section: command.section,
		});
		sections.set(command.section, items);
	}

	const ownedNames = new Set([
		...promptSpecs.filter((entry) => entry.section !== "Internal").map((entry) => entry.name),
		...extensionCommandSpecs.filter((entry) => entry.publicDocs).map((entry) => entry.name),
	]);

	for (const group of livePackageCommandGroups) {
		const commands: HelpCommand[] = [];
		for (const spec of group.commands) {
			const command = liveCommands.get(spec.name);
			if (!command || ownedNames.has(command.name)) continue;
			commands.push({
				usage: spec.usage,
				description: command.description ?? "",
				section: group.title,
			});
		}

		if (commands.length > 0) {
			sections.set(group.title, commands);
		}
	}

	return [
		"Research Workflows",
		"Project & Session",
		"Setup",
		"Agents & Delegation",
		"Live Package Commands",
	]
		.map((title) => ({ title, commands: sections.get(title) ?? [] }))
		.filter((section) => section.commands.length > 0);
}

export function registerHelpCommand(pi: ExtensionAPI): void {
	pi.registerCommand("help", {
		description:
			getExtensionCommandSpec("help")?.description ??
			"Search grouped Hypatia commands and prefill the composer without sending.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.ui.custom) {
				ctx.ui.notify("/help's searchable command panel is available in the interactive TUI.", "info");
				return;
			}
			const sections = buildHelpSections(pi);
			const commands: HelpPanelCommand[] = sections.flatMap((section) => section.commands.map((command) => ({
				...command,
				prefill: command.usage.split(/\s/u, 1)[0]! + (command.usage.includes(" ") ? " " : ""),
			})));
			await ctx.ui.custom<void>((tui, theme, _keys, done) => new HelpPanel(
				tui, theme, commands, (command) => ctx.ui.setEditorText(command.prefill), done,
			), { overlay: true, overlayOptions: { anchor: "bottom-center", width: "84%", maxHeight: "76%", offsetY: -4, margin: 1 } });
		},
	});
}

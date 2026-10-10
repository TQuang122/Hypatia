import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getExtensionCommandSpec } from "../../metadata/commands.mjs";
import { buildProjectAgentsTemplate, buildSessionLogsReadme } from "./project-scaffold.js";

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export function registerInitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("init", {
		description: getExtensionCommandSpec("init")?.description ?? "Initialize AGENTS.md and session-log folders for a research project.",
		handler: async (_args, ctx) => {
			const agentsPath = resolvePath(ctx.cwd, "AGENTS.md");
			const notesDir = resolvePath(ctx.cwd, "notes");
			const sessionLogsDir = resolvePath(notesDir, "session-logs");
			const sessionLogsReadmePath = resolvePath(sessionLogsDir, "README.md");
			const created: string[] = [];
			const skipped: string[] = [];

			await mkdir(notesDir, { recursive: true });
			await mkdir(sessionLogsDir, { recursive: true });

			if (!(await pathExists(agentsPath))) {
				await writeFile(agentsPath, buildProjectAgentsTemplate(), "utf8");
				created.push("AGENTS.md");
			} else {
				skipped.push("AGENTS.md");
			}

			if (!(await pathExists(sessionLogsReadmePath))) {
				await writeFile(sessionLogsReadmePath, buildSessionLogsReadme(), "utf8");
				created.push("notes/session-logs/README.md");
			} else {
				skipped.push("notes/session-logs/README.md");
			}

			const createdSummary = created.length > 0 ? `created: ${created.join(", ")}` : "created: nothing";
			const skippedSummary = skipped.length > 0 ? `; kept existing: ${skipped.join(", ")}` : "";
			ctx.ui.notify(`${createdSummary}${skippedSummary}`, "info");
		},
	});
}

export { registerOutputsCommand } from "./outputs.js";

import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	readSubagentModelRoutes,
	readSubagentModelSettings,
	resolveSubagentModelRoutes,
} from "./model-runtime.js";

export function getSubagentModelRoutes(agentDir: string): ReturnType<typeof resolveSubagentModelRoutes> {
	return resolveSubagentModelRoutes(
		readSubagentModelRoutes(join(agentDir, "model-routes.json")),
		readSubagentModelSettings(join(agentDir, "settings.json")),
	);
}

function formatRoutes(routes: ReturnType<typeof getSubagentModelRoutes>): string {
	return JSON.stringify(
		{
			schema: "hypatia.subagentModelRoutes.v1",
			roles: routes,
			fallbackPolicy:
				"Try the next model only when Pi rejects launch before the child starts because its model/provider is unavailable. If models is empty, omit the per-run model and use Pi's configured role or parent model.",
		},
		null,
		2,
	);
}

export function registerSubagentModelRoutes(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hypatia_subagent_models",
		label: "Subagent Models",
		description:
			"Read the ordered model route for Hypatia's evidence-scout, scribe, auditor, critic, and reviser roles. Call before delegation when choosing a role model; use the first listed model, and try the next only when Pi rejects launch before the child starts because its model/provider is unavailable.",
		promptSnippet: "Read the configured model order for Hypatia research subagents.",
		promptGuidelines: [
			"Each role's models are an ordered preference and fallback list. Pass the selected model as the subagent's per-run model override.",
			"An empty models list means inherit the Pi subagent override or parent model; do not invent a model ID.",
			"Retry the same role and task with the next listed model only when Pi rejects launch before the child starts because its model/provider is unavailable. Once a child starts, do not switch models for runtime errors or output quality.",
			"Use the actual model, role, and usage reported in subagent results when recording provenance.",
		],
		parameters: Type.Object({}),
		async execute() {
			const agentDir = process.env.PI_CODING_AGENT_DIR;
			if (!agentDir) {
				return {
					content: [{ type: "text", text: "Hypatia's Pi agent directory is unavailable; no model routes were loaded." }],
					isError: true,
					details: undefined,
				};
			}
			const routes = getSubagentModelRoutes(agentDir);
			return {
				content: [{ type: "text", text: formatRoutes(routes) }],
				details: routes,
			};
		},
	});
}

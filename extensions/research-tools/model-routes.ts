import { join } from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import {
	clearSubagentModelOverride,
	getConfiguredParentModel,
	getSubagentModelOverride,
	getSubagentThinkingOverride,
	readSubagentModelRoutes,
	readSubagentModelSettings,
	resolveSubagentModelRoutes,
	setSubagentThinkingOverride,
	SUBAGENT_MODEL_ROLES,
	SUBAGENT_THINKING_LEVELS,
	writeSubagentModelRoutes,
	type SubagentModelRole,
	type SubagentModelRoutes,
	type SubagentThinkingLevel,
} from "./model-runtime.js";
import { getAvailableModelRecords } from "./model-runtime.js";

const ROLE_LABELS: Record<SubagentModelRole, string> = {
	"evidence-scout": "Evidence Scout",
	scribe: "Scribe",
	auditor: "Auditor",
	critic: "Critic",
	reviser: "Reviser",
};

const FINISH = "__finish__";
const DONE = "__done__";
const CONFIGURE = "__configure__";
const CONFIGURE_THINKING = "__configure_thinking__";
const INHERIT_THINKING = "__inherit_thinking__";
const DISABLE_THINKING = "__disable_thinking__";
const INHERIT_PI = "__inherit_pi__";
const INHERIT_PARENT = "__inherit_parent__";
const BACK = "__back__";
const MAX_MODELS_PER_ROLE = 8;

type ModelRecord = {
	readonly provider: string;
	readonly id: string;
	readonly name?: string;
};

type RouteDialogContext = {
	readonly hasUI: boolean;
	readonly ui: Pick<ExtensionUIContext, "select" | "notify">;
};

type DialogOption<T extends string> = {
	readonly label: string;
	readonly value: T;
};

function routeSourceLabel(
	role: SubagentModelRole,
	routes: ReturnType<typeof resolveSubagentModelRoutes>,
	parentModel: string | undefined,
): string {
	const resolved = routes[role];
	if (resolved.source === "model-routes") return `Route · ${resolved.models.join(" → ")}`;
	if (resolved.source === "pi-settings") return `Pi override · ${resolved.models[0]}`;
	return `Parent · ${parentModel ?? "not set"}`;
}

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

function modelSpec(model: ModelRecord): string {
	return `${model.provider}/${model.id}`;
}

function modelOptions(models: readonly ModelRecord[]): DialogOption<string>[] {
	return models
		.slice()
		.sort((left, right) => modelSpec(left).localeCompare(modelSpec(right)))
		.map((model) => ({
			value: modelSpec(model),
			label: model.name ? `${model.name} — ${modelSpec(model)}` : modelSpec(model),
		}));
}

function preferredModelOptions(
	options: readonly DialogOption<string>[],
	preferredSpecs: readonly string[],
): DialogOption<string>[] {
	const preferred = preferredSpecs.flatMap((spec) => {
		const option = options.find((candidate) => candidate.value === spec);
		return option ? [option] : [];
	});
	const preferredSet = new Set(preferred.map((option) => option.value));
	return [...preferred, ...options.filter((option) => !preferredSet.has(option.value))];
}

async function selectValue<T extends string>(
	ctx: RouteDialogContext,
	title: string,
	options: readonly DialogOption<T>[],
): Promise<T | undefined> {
	const selected = await ctx.ui.select(title, options.map((option) => option.label));
	return options.find((option) => option.label === selected)?.value;
}

function saveRoleRoute(
	path: string,
	routes: SubagentModelRoutes,
	role: SubagentModelRole,
	models: readonly string[] | undefined,
): SubagentModelRoutes {
	const roles = { ...routes.roles };
	if (models) {
		roles[role] = [...models];
	} else {
		delete roles[role];
	}
	const updated = { version: 1 as const, roles };
	writeSubagentModelRoutes(path, updated);
	return updated;
}

export async function runSubagentModelRoutesDialog(
	ctx: RouteDialogContext,
	agentDir: string,
	availableModels: readonly ModelRecord[],
	parentModelSpec?: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Run /model-routes in the interactive chat TUI.", "error");
		return;
	}

	const routePath = join(agentDir, "model-routes.json");
	const settingsPath = join(agentDir, "settings.json");
	const availableOptions = modelOptions(availableModels);
	let routes = readSubagentModelRoutes(routePath);

	while (true) {
		const settings = readSubagentModelSettings(settingsPath);
		const parentModel = parentModelSpec ?? getConfiguredParentModel(settings);
		const resolved = resolveSubagentModelRoutes(routes, settings);
		const roleOptions: DialogOption<SubagentModelRole | typeof DONE>[] = [
			...SUBAGENT_MODEL_ROLES.map((role) => {
				const thinking = getSubagentThinkingOverride(settings, role);
				return {
					value: role,
					label: `${ROLE_LABELS[role]} — ${routeSourceLabel(role, resolved, parentModel)} · thinking ${thinking === false ? "disabled" : thinking ?? "inherited"}`,
				};
			}),
			{ value: DONE, label: "Finish" },
		];
		const role = await selectValue(ctx, "Choose a subagent role to configure", roleOptions);
		if (!role || role === DONE) return;

		const piOverride = getSubagentModelOverride(settings, role);
		const thinkingOverride = getSubagentThinkingOverride(settings, role);
		const actionOptions: DialogOption<string>[] = [
			{ value: CONFIGURE, label: "Choose primary model and ordered fallbacks" },
			{ value: CONFIGURE_THINKING, label: `Choose thinking level · ${thinkingOverride === false ? "disabled" : thinkingOverride ?? "inherited"}` },
			...(piOverride ? [{ value: INHERIT_PI, label: `Use Pi override · ${piOverride}` }] : []),
			{ value: INHERIT_PARENT, label: `Inherit parent model${parentModel ? ` · ${parentModel}` : ""}` },
			{ value: BACK, label: "Back without changing this role" },
		];
		const action = await selectValue(ctx, `Model route for ${ROLE_LABELS[role]}`, actionOptions);
		if (!action) return;
		if (action === BACK) continue;
		if (action === INHERIT_PI) {
			routes = saveRoleRoute(routePath, routes, role, undefined);
			ctx.ui.notify(`${ROLE_LABELS[role]} will use its Pi role override.`, "info");
			continue;
		}
		if (action === INHERIT_PARENT) {
			clearSubagentModelOverride(settingsPath, role);
			routes = saveRoleRoute(routePath, routes, role, undefined);
			ctx.ui.notify(`${ROLE_LABELS[role]} will inherit the parent model.`, "info");
			continue;
		}
		if (action === CONFIGURE_THINKING) {
			const currentThinking = getSubagentThinkingOverride(settings, role);
			const thinkingOptions: DialogOption<SubagentThinkingLevel | typeof INHERIT_THINKING | typeof DISABLE_THINKING>[] = [
				{ value: INHERIT_THINKING, label: "Use the agent or Pi default" },
				{ value: DISABLE_THINKING, label: "Do not request a thinking level" },
				...SUBAGENT_THINKING_LEVELS.map((level) => ({
					value: level,
					label: `${level}${currentThinking === level ? " · current" : ""}`,
				})),
			];
			const thinking = await selectValue(ctx, `Thinking level for ${ROLE_LABELS[role]}`, thinkingOptions);
			if (!thinking) return;
			if (thinking === INHERIT_THINKING) {
				setSubagentThinkingOverride(settingsPath, role, undefined);
				ctx.ui.notify(`${ROLE_LABELS[role]} will use its agent/Pi thinking default.`, "info");
			} else if (thinking === DISABLE_THINKING) {
				setSubagentThinkingOverride(settingsPath, role, false);
				ctx.ui.notify(`${ROLE_LABELS[role]} will not request a thinking level.`, "info");
			} else {
				setSubagentThinkingOverride(settingsPath, role, thinking);
				ctx.ui.notify(`${ROLE_LABELS[role]} thinking set to ${thinking}.`, "info");
			}
			continue;
		}
		if (availableOptions.length === 0) {
			ctx.ui.notify("No authenticated non-premium models are available to configure.", "warning");
			continue;
		}

		const currentModels = routes.roles[role] ?? [];
		const primary = await selectValue(
			ctx,
			`Primary model for ${ROLE_LABELS[role]}`,
			preferredModelOptions(availableOptions, currentModels),
		);
		if (!primary) return;

		const ordered = [primary];
		while (ordered.length < MAX_MODELS_PER_ROLE) {
			const remaining = availableOptions.filter((option) => !ordered.includes(option.value));
			const fallbackOptions: DialogOption<string>[] = [
				{ value: FINISH, label: "Finish route" },
				...preferredModelOptions(remaining, currentModels.slice(ordered.length)),
			];
			const fallback = await selectValue(
				ctx,
				`Fallback ${ordered.length} for ${ROLE_LABELS[role]} (in order)`,
				fallbackOptions,
			);
			if (!fallback) return;
			if (fallback === FINISH) break;
			ordered.push(fallback);
		}

		routes = saveRoleRoute(routePath, routes, role, ordered);
		ctx.ui.notify(`${ROLE_LABELS[role]} route saved: ${ordered.join(" → ")}`, "info");
	}
}

export function registerSubagentModelRoutesCommand(pi: ExtensionAPI): void {
	pi.registerCommand("model-routes", {
		description: "Configure ordered primary and fallback models for each subagent role.",
		handler: async (_args, ctx: CommandContext) => {
			const agentDir = process.env.PI_CODING_AGENT_DIR;
			if (!agentDir) {
				ctx.ui.notify("Hypatia's agent directory is unavailable; model routes were not loaded.", "error");
				return;
			}
			const availableModels = await getAvailableModelRecords(join(agentDir, "auth.json"));
			const parentModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: getConfiguredParentModel(readSubagentModelSettings(join(agentDir, "settings.json")));
			await runSubagentModelRoutesDialog(ctx, agentDir, availableModels, parentModel);
		},
	});
}

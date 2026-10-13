import { join } from "node:path";

import {
	readSubagentModelRoutes,
	readSubagentModelSettings,
	clearSubagentModelOverride,
	getConfiguredParentModel,
	getSubagentModelOverride,
	getSubagentThinkingOverride,
	resolveSubagentModelRoutes,
	SUBAGENT_MODEL_ROLES,
	SUBAGENT_THINKING_LEVELS,
	setSubagentThinkingOverride,
	writeSubagentModelRoutes,
	type SubagentModelRole,
	type SubagentModelRoutes,
	type SubagentThinkingLevel,
	type SubagentThinkingOverride,
} from "./role-routing.js";
import { getAvailableModelRecords } from "./catalog.js";
import {
	isInteractiveTerminal,
	promptSelect,
	SetupCancelledError,
	type PromptSelectOption,
} from "../setup/prompts.js";
import { printInfo, printSuccess, printWarning } from "../ui/terminal.js";

const ROLE_LABELS: Record<SubagentModelRole, string> = {
	"evidence-scout": "Evidence Scout",
	scribe: "Scribe",
	auditor: "Auditor",
	critic: "Critic",
	reviser: "Reviser",
};
const BACK = "__back__";
const FINISH = "__finish__";
const INHERIT_THINKING = "__inherit_thinking__";
const DISABLE_THINKING = "__disable_thinking__";
const INHERIT_PI = "__inherit_pi__";
const INHERIT_PARENT = "__inherit_parent__";

type RouteEditResult =
	| { kind: "back" }
	| { kind: "inherit-pi" }
	| { kind: "inherit-parent" }
	| { kind: "thinking"; level: SubagentThinkingOverride }
	| { kind: "configured"; models: string[] };
type RouteAction = "configure" | "configure-thinking" | typeof INHERIT_PI | typeof INHERIT_PARENT | "back";

function modelSpec(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function modelOptions(models: { provider: string; id: string; name?: string }[]): { value: string; label: string; hint?: string }[] {
	return models
		.slice()
		.sort((left, right) => modelSpec(left).localeCompare(modelSpec(right)))
		.map((model) => {
			const spec = modelSpec(model);
			return {
				value: spec,
				label: model.name ?? spec,
				hint: model.name ? spec : undefined,
			};
		});
}

function saveRoleRoute(
	path: string,
	routes: SubagentModelRoutes,
	role: SubagentModelRole,
	models: string[] | undefined,
): SubagentModelRoutes {
	const roles = { ...routes.roles };
	if (models) {
		roles[role] = models;
	} else {
		delete roles[role];
	}
	const updated = { version: 1 as const, roles };
	writeSubagentModelRoutes(path, updated);
	return updated;
}

async function configureRoleRoute(
	role: SubagentModelRole,
	currentModels: string[],
	piOverride: string | undefined,
	parentModel: string | undefined,
	currentThinking: SubagentThinkingOverride,
	availableModels: { value: string; label: string; hint?: string }[],
): Promise<RouteEditResult> {
	const options: PromptSelectOption<RouteAction>[] = [
		{ value: "configure", label: "Choose primary model and ordered fallbacks" },
		{ value: "configure-thinking", label: `Choose thinking level · ${currentThinking === false ? "disabled" : currentThinking ?? "inherited"}` },
	];
	if (piOverride) options.push({ value: INHERIT_PI, label: `Use Pi override · ${piOverride}` });
	options.push({ value: INHERIT_PARENT, label: `Inherit parent model${parentModel ? ` · ${parentModel}` : ""}` });
	options.push({ value: "back", label: "Back without changing this role" });
	const initialValue: RouteAction = currentModels.length > 0
		? "configure"
		: piOverride
			? INHERIT_PI
			: INHERIT_PARENT;
	const action = await promptSelect<RouteAction>(`Model route for ${ROLE_LABELS[role]}:`, options, initialValue);
	if (action === "back") return { kind: "back" };
	if (action === INHERIT_PI) return { kind: "inherit-pi" };
	if (action === INHERIT_PARENT) return { kind: "inherit-parent" };
	if (action === "configure-thinking") {
		const level = await promptSelect<SubagentThinkingLevel | typeof INHERIT_THINKING | typeof DISABLE_THINKING>(
			`Thinking level for ${ROLE_LABELS[role]}:`,
			[
				{ value: INHERIT_THINKING, label: "Use the agent or Pi default" },
				{ value: DISABLE_THINKING, label: "Do not request a thinking level" },
				...SUBAGENT_THINKING_LEVELS.map((value) => ({
					value,
					label: `${value}${currentThinking === value ? " (current)" : ""}`,
				})),
			],
			currentThinking === false ? DISABLE_THINKING : currentThinking ?? INHERIT_THINKING,
		);
		return { kind: "thinking", level: level === INHERIT_THINKING ? undefined : level === DISABLE_THINKING ? false : level };
	}
	if (availableModels.length === 0) {
		printWarning("No authenticated non-premium models are available to configure.");
		return { kind: "back" };
	}

	const availableSpecs = new Set(availableModels.map((model) => model.value));
	const currentAvailable = currentModels.filter((model) => availableSpecs.has(model));
	const primary = await promptSelect(
		`Primary model for ${ROLE_LABELS[role]}:`,
		[...availableModels, { value: BACK, label: "Back without changing this role" }],
		currentAvailable[0],
	);
	if (primary === BACK) return { kind: "back" };

	const ordered = [primary];
	while (ordered.length < 8) {
		const fallback = await promptSelect(
			`Fallback ${ordered.length} for ${ROLE_LABELS[role]} (in order):`,
			[
				{ value: FINISH, label: "Finish route" },
				...availableModels.filter((model) => !ordered.includes(model.value)),
			],
			currentAvailable[ordered.length] ?? FINISH,
		);
		if (fallback === FINISH) break;
		ordered.push(fallback);
	}
	return { kind: "configured", models: ordered };
}

export function printSubagentModelRoutesJson(agentDir: string): void {
	const configured = readSubagentModelRoutes(join(agentDir, "model-routes.json"));
	const settings = readSubagentModelSettings(join(agentDir, "settings.json"));
	console.log(JSON.stringify({
		schema: "hypatia.subagentModelRoutes.v1",
		roles: resolveSubagentModelRoutes(configured, settings),
	}, null, 2));
}

export async function runSubagentModelRouteEditor(authPath: string, agentDir: string): Promise<void> {
	if (!isInteractiveTerminal()) {
		throw new Error("Route editing requires an interactive terminal. Use `hypatia model routes --json` to inspect routes.");
	}

	const path = join(agentDir, "model-routes.json");
	const settingsPath = join(agentDir, "settings.json");
	const availableModels = modelOptions(await getAvailableModelRecords(authPath));
	let routes = readSubagentModelRoutes(path);
	printInfo("Choose a primary model, then add fallback models in the order Pi should try them.");
	printInfo("Fallback is only for a Pi launch rejection before the child starts; it is not used after execution begins.");

	try {
		while (true) {
			const settings = readSubagentModelSettings(settingsPath);
			const resolved = resolveSubagentModelRoutes(routes, settings);
			const parentModel = getConfiguredParentModel(settings);
			const role = await promptSelect<SubagentModelRole | "done">(
				"Choose a subagent role to configure:",
				[
					...SUBAGENT_MODEL_ROLES.map((value) => ({
						value,
						label: ROLE_LABELS[value],
						hint: `${resolved[value].source === "model-routes"
							? `route ${resolved[value].models.join(" -> ")}`
							: resolved[value].source === "pi-settings"
								? `Pi override ${resolved[value].models[0]}`
								: `parent ${parentModel ?? "not set"}`} · thinking ${getSubagentThinkingOverride(settings, value) === false ? "disabled" : getSubagentThinkingOverride(settings, value) ?? "inherited"}`,
					})),
					{ value: "done", label: "Finish" },
				],
				"done",
			);
			if (role === "done") return;

			const choice = await configureRoleRoute(
				role,
				routes.roles[role] ?? [],
				getSubagentModelOverride(settings, role),
				parentModel,
				getSubagentThinkingOverride(settings, role),
				availableModels,
			);
			if (choice.kind === "back") continue;
			if (choice.kind === "thinking") {
				setSubagentThinkingOverride(settingsPath, role, choice.level);
				printSuccess(choice.level === false
					? `${ROLE_LABELS[role]} will not request a thinking level.`
					: choice.level
					? `${ROLE_LABELS[role]} thinking set to ${choice.level}.`
					: `${ROLE_LABELS[role]} will use its agent/Pi thinking default.`);
				continue;
			}
			if (choice.kind === "inherit-pi") {
				routes = saveRoleRoute(path, routes, role, undefined);
				printSuccess(`${ROLE_LABELS[role]} will use its Pi role override.`);
				continue;
			}
			if (choice.kind === "inherit-parent") {
				clearSubagentModelOverride(settingsPath, role);
				routes = saveRoleRoute(path, routes, role, undefined);
				printSuccess(`${ROLE_LABELS[role]} will inherit the parent model.`);
				continue;
			}
			routes = saveRoleRoute(path, routes, role, choice.models);
			printSuccess(
				`${ROLE_LABELS[role]} route saved: ${choice.models.join(" -> ")}`,
			);
		}
	} catch (error) {
		if (error instanceof SetupCancelledError) {
			printInfo("Route editing cancelled; completed role changes were saved.");
			return;
		}
		throw error;
	}
}

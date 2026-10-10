import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SUBAGENT_MODEL_ROLES = ["evidence-scout", "scribe", "auditor", "critic", "reviser"] as const;

export type SubagentModelRole = (typeof SUBAGENT_MODEL_ROLES)[number];
export type SubagentModelRoutes = {
	version: 1;
	roles: Partial<Record<SubagentModelRole, string[]>>;
};
export type ResolvedSubagentModelRoute = {
	models: string[];
	source: "model-routes" | "pi-settings" | "inherit";
};

const MAX_MODELS_PER_ROLE = 8;
const LEGACY_MODEL_ROLES: Record<string, SubagentModelRole> = {
	researcher: "evidence-scout",
	writer: "scribe",
	verifier: "auditor",
	reviewer: "critic",
	patcher: "reviser",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidRoutes(reason: string): never {
	throw new Error(`Invalid subagent model routes: ${reason}`);
}

function isRole(value: string): value is SubagentModelRole {
	return SUBAGENT_MODEL_ROLES.some((role) => role === value);
}

function isFullyQualifiedModelSpec(value: string): boolean {
	const separator = value.indexOf("/");
	return separator > 0 && separator < value.length - 1 && !/\s/.test(value);
}

function writeJsonAtomically(path: string, value: object): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const temporaryPath = join(parent, `.model-config-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

export function parseSubagentModelRoutes(value: unknown): SubagentModelRoutes {
	if (!isRecord(value)) invalidRoutes("expected a JSON object.");
	if (value.version !== 1) invalidRoutes("version must be 1.");
	if (!isRecord(value.roles)) invalidRoutes("roles must be an object.");
	if (Object.keys(value).some((key) => key !== "version" && key !== "roles")) {
		invalidRoutes("only version and roles are supported.");
	}

	const roles: SubagentModelRoutes["roles"] = {};
	const canonicalRoles = new Set<SubagentModelRole>();
	for (const [role, models] of Object.entries(value.roles)) {
		const normalizedRole = isRole(role) ? role : LEGACY_MODEL_ROLES[role];
		if (!normalizedRole) invalidRoutes(`unknown role "${role}".`);
		if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS_PER_ROLE) {
			invalidRoutes(`roles.${role} must contain 1-${MAX_MODELS_PER_ROLE} model IDs.`);
		}
		const unique = new Set<string>();
		const orderedModels: string[] = [];
		for (const model of models) {
			if (typeof model !== "string" || !isFullyQualifiedModelSpec(model)) {
				invalidRoutes(`roles.${role} entries must be fully qualified provider/model IDs.`);
			}
			if (unique.has(model)) invalidRoutes(`roles.${role} contains duplicate model "${model}".`);
			unique.add(model);
			orderedModels.push(model);
		}
		if (isRole(role)) {
			roles[normalizedRole] = orderedModels;
			canonicalRoles.add(normalizedRole);
		} else if (!canonicalRoles.has(normalizedRole)) {
			roles[normalizedRole] = orderedModels;
		}
	}

	return { version: 1, roles };
}

export function writeSubagentModelRoutes(path: string, value: unknown): void {
	const routes = parseSubagentModelRoutes(value);
	writeJsonAtomically(path, routes);
}

export function readSubagentModelRoutes(path: string): SubagentModelRoutes {
	if (!existsSync(path)) return { version: 1, roles: {} };
	let source: string;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Failed to read subagent model routes at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new Error(
			`Invalid subagent model routes at ${path}: ${error instanceof Error ? error.message : "expected valid JSON"}`,
		);
	}
	try {
		return parseSubagentModelRoutes(value);
	} catch (error) {
		throw new Error(`Invalid subagent model routes at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function readSubagentModelSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let source: string;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Failed to read Pi settings at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new Error(`Invalid Pi settings at ${path}: ${error instanceof Error ? error.message : "expected valid JSON"}`);
	}
	if (!isRecord(value)) throw new Error(`Invalid Pi settings at ${path}: expected a JSON object.`);
	return value;
}

export function getSubagentModelOverride(settings: unknown, role: SubagentModelRole): string | undefined {
	if (!isRecord(settings) || !isRecord(settings.subagents) || !isRecord(settings.subagents.agentOverrides)) {
		return undefined;
	}
	const override = settings.subagents.agentOverrides[role];
	if (!isRecord(override) || typeof override.model !== "string" || !override.model.trim()) return undefined;
	const model = override.model.trim();
	return model === "inherit" ? undefined : model;
}

export function getConfiguredParentModel(settings: unknown): string | undefined {
	if (!isRecord(settings)) return undefined;
	const provider = settings.defaultProvider;
	const model = settings.defaultModel;
	return typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : undefined;
}

export function clearSubagentModelOverride(path: string, role: SubagentModelRole): void {
	const settings = readSubagentModelSettings(path);
	if (!isRecord(settings.subagents) || !isRecord(settings.subagents.agentOverrides)) return;

	const overrides = settings.subagents.agentOverrides;
	const current = overrides[role];
	if (!isRecord(current) || !Object.hasOwn(current, "model")) return;

	const updatedCurrent = { ...current };
	delete updatedCurrent.model;
	const updatedOverrides = { ...overrides };
	if (Object.keys(updatedCurrent).length === 0) delete updatedOverrides[role];
	else updatedOverrides[role] = updatedCurrent;

	writeJsonAtomically(path, {
		...settings,
		subagents: {
			...settings.subagents,
			agentOverrides: updatedOverrides,
		},
	});
}

function resolveRole(
	role: SubagentModelRole,
	routes: SubagentModelRoutes,
	settings: unknown,
): ResolvedSubagentModelRoute {
	const configured = routes.roles[role];
	if (configured) return { models: [...configured], source: "model-routes" };
	const native = getSubagentModelOverride(settings, role);
	if (native) return { models: [native], source: "pi-settings" };
	return { models: [], source: "inherit" };
}

export function resolveSubagentModelRoutes(
	routes: SubagentModelRoutes,
	settings: unknown,
): Record<SubagentModelRole, ResolvedSubagentModelRoute> {
	return {
		"evidence-scout": resolveRole("evidence-scout", routes, settings),
		scribe: resolveRole("scribe", routes, settings),
		auditor: resolveRole("auditor", routes, settings),
		critic: resolveRole("critic", routes, settings),
		reviser: resolveRole("reviser", routes, settings),
	};
}

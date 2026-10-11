import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AZURE_PROVIDER_ID, LEGACY_AZURE_PROVIDER_ID } from "./api-key-providers.js";

type JsonRecord = Record<string, unknown>;
type MigrationPlan = { path: string; original: string; updated: string };

function errorCode(error: unknown): string {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
	return "unknown error";
}

function record(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function rewriteModelSpec(value: unknown): { value: unknown; changed: boolean } {
	if (typeof value !== "string") return { value, changed: false };
	for (const separator of ["/", ":"]) {
		const prefix = `${LEGACY_AZURE_PROVIDER_ID}${separator}`;
		if (value.startsWith(prefix)) return { value: `${AZURE_PROVIDER_ID}${value.slice(LEGACY_AZURE_PROVIDER_ID.length)}`, changed: true };
	}
	return { value, changed: false };
}

function moveProviderKey(container: JsonRecord, file: string): boolean {
	if (!Object.hasOwn(container, LEGACY_AZURE_PROVIDER_ID)) return false;
	const legacyValue = container[LEGACY_AZURE_PROVIDER_ID];
	if (Object.hasOwn(container, AZURE_PROVIDER_ID)) {
		if (!isDeepStrictEqual(container[AZURE_PROVIDER_ID], legacyValue)) {
			throw new Error(`Both legacy and current Azure provider entries exist in ${file}; merge them manually. No configuration was changed.`);
		}
		delete container[LEGACY_AZURE_PROVIDER_ID];
		return true;
	}
	container[AZURE_PROVIDER_ID] = legacyValue;
	delete container[LEGACY_AZURE_PROVIDER_ID];
	return true;
}

function migrateAuth(value: JsonRecord): boolean {
	return moveProviderKey(value, "auth.json");
}

function migrateModels(value: JsonRecord): boolean {
	const providers = record(value.providers);
	return providers ? moveProviderKey(providers, "models.json") : false;
}

function migrateSettings(value: JsonRecord): boolean {
	let changed = false;
	if (value.defaultProvider === LEGACY_AZURE_PROVIDER_ID) {
		value.defaultProvider = AZURE_PROVIDER_ID;
		changed = true;
	}
	const subagents = record(value.subagents);
	const overrideSets = [
		record(subagents?.agentOverrides),
		...Object.values(record(subagents?.agentOverridesByProvider) ?? {}).map(record),
	];
	for (const overrides of overrideSets) {
		for (const override of Object.values(overrides ?? {})) {
			const agent = record(override);
			if (!agent) continue;
			const migrated = rewriteModelSpec(agent.model);
			if (migrated.changed) {
				agent.model = migrated.value;
				changed = true;
			}
		}
	}
	return changed;
}

function migrateRoutes(value: JsonRecord): boolean {
	const roles = record(value.roles);
	if (!roles) return false;
	let changed = false;
	for (const [role, models] of Object.entries(roles)) {
		if (!Array.isArray(models)) continue;
		const rewritten = models.map((model) => {
			const migrated = rewriteModelSpec(model);
			changed ||= migrated.changed;
			return migrated.value;
		});
		const stringModels = rewritten.filter((model): model is string => typeof model === "string");
		if (new Set(stringModels).size !== stringModels.length) {
			throw new Error("Azure provider migration would create duplicate model routes in model-routes.json. No configuration was changed.");
		}
		roles[role] = rewritten;
	}
	return changed;
}

function preparePlan(path: string, transform: (value: JsonRecord) => boolean): MigrationPlan | undefined {
	if (!existsSync(path)) return undefined;
	let canonicalPath: string;
	let original: string;
	try {
		canonicalPath = realpathSync(path);
		original = readFileSync(canonicalPath, "utf8");
	} catch (error) {
		throw new Error(`Cannot read ${basename(path)} for Azure provider migration (${errorCode(error)}). No configuration was changed.`);
	}
	if (!original.includes(LEGACY_AZURE_PROVIDER_ID)) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(original.replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`Cannot migrate the Azure provider in ${basename(path)} because it is not valid JSON. No configuration was changed.`);
	}
	const config = record(value);
	if (!config) return undefined;
	if (!transform(config)) return undefined;
	return { path: canonicalPath, original, updated: `${JSON.stringify(config, null, 2)}\n` };
}

function writeTemporary(path: string, source: string): string {
	const temporary = join(dirname(path), `.${basename(path)}.azure-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		try {
			if (existsSync(temporary)) unlinkSync(temporary);
		} catch {
			// Keep the surfaced error free of paths and config contents.
		}
		throw new Error(`Cannot stage ${basename(path)} for Azure provider migration (${errorCode(error)}).`);
	}
	return temporary;
}

/** Rename Pi's retired Azure provider ID in Hypatia-owned user config files. */
export function migrateLegacyAzureProviderConfig(authPath: string, settingsPath: string): boolean {
	const modelsPath = resolve(dirname(resolve(authPath)), "models.json");
	const settingsDir = dirname(resolve(settingsPath));
	const plans = [
		preparePlan(authPath, migrateAuth),
		preparePlan(modelsPath, migrateModels),
		preparePlan(settingsPath, migrateSettings),
		preparePlan(resolve(settingsDir, "model-routes.json"), migrateRoutes),
	].filter((plan): plan is MigrationPlan => plan !== undefined);
	if (plans.length === 0) return false;
	if (new Set(plans.map((plan) => plan.path)).size !== plans.length) {
		throw new Error("Azure provider settings resolve to the same file through multiple paths. No configuration was changed.");
	}

	const staged: Array<MigrationPlan & { temporary: string; committed: boolean }> = [];
	try {
		for (const plan of plans) staged.push({ ...plan, temporary: writeTemporary(plan.path, plan.updated), committed: false });
		for (const plan of plans) {
			if (readFileSync(plan.path, "utf8") !== plan.original) {
				throw new Error(`Azure provider configuration changed while migration was prepared (${basename(plan.path)}). Retry Hypatia startup.`);
			}
		}
		for (const item of staged) {
			if (readFileSync(item.path, "utf8") !== item.original) {
				throw new Error(`Azure provider configuration changed during migration (${basename(item.path)}). Retry Hypatia startup.`);
			}
			renameSync(item.temporary, item.path);
			item.committed = true;
		}
		return true;
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const item of [...staged].reverse()) {
			if (!item.committed) continue;
			let rollback: string | undefined;
			try {
				rollback = writeTemporary(item.path, item.original);
				renameSync(rollback, item.path);
			} catch (rollbackError) {
				rollbackErrors.push(`${basename(item.path)} (${errorCode(rollbackError)})`);
			} finally {
				try {
					if (rollback && existsSync(rollback)) unlinkSync(rollback);
				} catch {
					// Keep the surfaced error free of paths and config contents.
				}
			}
		}
		for (const item of staged) {
			try {
				if (existsSync(item.temporary)) unlinkSync(item.temporary);
			} catch {
				// Keep the surfaced error free of paths and config contents.
			}
		}
		const changedFiles = staged.map((item) => basename(item.path)).join(", ");
		const code = errorCode(error);
		if (rollbackErrors.length > 0) {
			throw new Error(`Azure provider migration failed (${code}) for ${changedFiles}; rollback failed for ${rollbackErrors.join(", ")}. Inspect those config files manually.`);
		}
		throw new Error(`Azure provider migration failed (${code}) for ${changedFiles}; no migration changes remain. Check file permissions and retry.`);
	}
}

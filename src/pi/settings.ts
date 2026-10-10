import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DefaultPackageManager, loadSkills, SettingsManager, type ModelRegistry, type ModelRuntime, type PackageSource } from "@earendil-works/pi-coding-agent";

import { BUNDLED_PI_PACKAGES, getHypatiaPackageSources, resolvePackageRoot } from "./runtime.js";
import { choosePreferredModelRecord, getAvailableModelRecords } from "../model/catalog.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ModelLookup = Pick<ModelRegistry, "find"> | Pick<ModelRuntime, "getModel">;

// Written by Hypatia <= 0.4.0 next to a subagent extension path it managed.
const LEGACY_RESEARCHER_EXTENSION_MARKER = "_hypatiaResearchToolsExtension";
const SUBAGENT_AGENT_NAME_MIGRATION_MARKER = ".hypatia-agent-name-migration-v1";
const SETTINGS_LOCK_FILE = ".hypatia-settings.lock";
const SETTINGS_LOCK_TIMEOUT_MS = 30_000;
const LEGACY_SUBAGENT_AGENT_NAMES: Record<string, string> = {
	researcher: "evidence-scout",
	writer: "scribe",
	verifier: "auditor",
	reviewer: "critic",
	patcher: "reviser",
};

function findModel(modelLookup: ModelLookup, provider: string, id: string) {
	return "find" in modelLookup
		? modelLookup.find(provider, id)
		: modelLookup.getModel(provider, id);
}

export function parseModelSpec(spec: string, modelLookup: ModelLookup) {
	const trimmed = spec.trim();
	for (const separator of ["/", ":"] as const) {
		const separatorIndex = trimmed.indexOf(separator);
		if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
			continue;
		}

		const provider = trimmed.slice(0, separatorIndex);
		const id = trimmed.slice(separatorIndex + 1);
		const model = findModel(modelLookup, provider, id);
		if (model) {
			return model;
		}
	}

	return undefined;
}

export function canonicalizeModelSpec(spec: string, modelLookup: ModelLookup): string | undefined {
	const model = parseModelSpec(spec, modelLookup);
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.toLowerCase();
	if (
		normalized === "off" ||
		normalized === "minimal" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high" ||
		normalized === "xhigh" ||
		normalized === "max"
	) {
		return normalized;
	}

	return undefined;
}

export function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) {
		return {};
	}

	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (process.env.HYPATIA_DEBUG === "1") {
			process.stderr.write(
				`[hypatia] warning: failed to parse ${path}, treating as empty (${error instanceof Error ? error.message : "unknown error"})\n`,
			);
		}
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readConfigObject(path: string, label: string): { source: string; value: Record<string, unknown> } {
	const source = readFileSync(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error(`Invalid ${label} at ${path}: expected a JSON object. The file was not changed.`);
	}
	if (!isRecord(value)) {
		throw new Error(`Invalid ${label} at ${path}: expected a JSON object. The file was not changed.`);
	}
	return { source, value };
}

function prepareSubagentDefaults(settingsPath: string) {
	// cli.ts passes <hypatiaAgentDir>/settings.json. Do not derive this from
	// HOME, authPath, the project cwd, or a potentially unrelated Pi env var.
	const path = join(dirname(settingsPath), "extensions", "subagent", "config.json");
	const existing = existsSync(path) ? readConfigObject(path, "subagent config") : undefined;
	const config = existing?.value ?? {};
	if (config.missions !== undefined && !isRecord(config.missions)) {
		throw new Error(`Invalid subagent config at ${path}: missions must be an object. The file was not changed.`);
	}
	const missions = config.missions ?? {};
	for (const [key, value] of [
		["missions.enabled", missions.enabled],
		["fleetView", config.fleetView],
		["asyncByDefault", config.asyncByDefault],
	] as const) {
		if (value !== undefined && typeof value !== "boolean") {
			throw new Error(`Invalid subagent config at ${path}: ${key} must be a boolean. The file was not changed.`);
		}
	}
	if (config.singleRunOutputBaseDir !== undefined && typeof config.singleRunOutputBaseDir !== "string") {
		throw new Error(`Invalid subagent config at ${path}: singleRunOutputBaseDir must be a string. The file was not changed.`);
	}
	if (
		missions.enabled !== undefined &&
		config.fleetView !== undefined &&
		config.asyncByDefault !== undefined &&
		config.singleRunOutputBaseDir !== undefined
	) {
		return undefined;
	}
	const next = {
		...config,
		missions: { ...missions, enabled: missions.enabled ?? false },
		fleetView: config.fleetView ?? false,
		asyncByDefault: config.asyncByDefault ?? true,
		// pi-subagents otherwise saves a relative `output` such as
		// outputs/.drafts/x.md under the session's subagent-artifacts folder, where
		// the lead agent never looks. "." resolves against Pi's cwd, the workspace.
		singleRunOutputBaseDir: config.singleRunOutputBaseDir ?? ".",
	};
	return { path, original: existing?.source, content: `${JSON.stringify(next, null, 2)}\n` };
}

function packageSourceName(source: string): string | undefined {
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length).match(/^(@?[^@]+)/)?.[1];
	}
	const manifestPath = join(source, "package.json");
	if (!existsSync(manifestPath)) return undefined;
	try {
		return (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string }).name;
	} catch {
		return undefined;
	}
}

// Hypatia and its bundled Pi packages load as local-path packages, so child
// sessions (pi-subagents) see the same resources as the main session. Entries
// for those packages from any other install or version are replaced; npm
// entries for them are the pinned core list written by Hypatia <= 0.4.0.
export function reconcileHypatiaPackages(packages: unknown, appRoot: string, disabledHypatiaSkills: string[] = []): PackageSource[] {
	const hypatiaName = (JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { name: string }).name;
	const managedNames = new Set<string>([hypatiaName, "@companion-ai/alpha-hub", "pi-otel", ...BUNDLED_PI_PACKAGES]);
	const configured = Array.isArray(packages) ? (packages as PackageSource[]) : [];
	const userPackages = configured.filter((entry) => {
		const source = typeof entry === "string" ? entry : entry.source;
		const name = typeof source === "string" ? packageSourceName(source) : undefined;
		return !name || !managedNames.has(name);
	});
	return [...getHypatiaPackageSources(appRoot, disabledHypatiaSkills), ...userPackages];
}

function isInsidePath(filePath: string, rootPath: string): boolean {
	const rel = relative(resolve(rootPath), resolve(filePath));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

async function findShadowedHypatiaSkillPaths(settingsPath: string, appRoot: string, cwd: string): Promise<string[]> {
	const agentDir = dirname(settingsPath);
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const configured = await packageManager.resolve(async () => "skip");
	const bundled = await packageManager.resolveExtensionSources([appRoot], { temporary: true });
	const externalSkillPaths = configured.skills
		.filter((skill) => skill.enabled && !isInsidePath(skill.path, appRoot))
		.map((skill) => skill.path);
	const bundledSkillPaths = bundled.skills.filter((skill) => skill.enabled).map((skill) => skill.path);
	const loaded = loadSkills({
		cwd,
		agentDir,
		skillPaths: [...externalSkillPaths, ...bundledSkillPaths],
		includeDefaults: false,
	});
	return [...new Set(loaded.diagnostics.flatMap((diagnostic) => {
		const collision = diagnostic.collision;
		if (diagnostic.type !== "collision" || collision?.resourceType !== "skill" || !isInsidePath(collision.loserPath, appRoot)) return [];
		const rel = toPosixPath(relative(resolve(appRoot), resolve(collision.loserPath)));
		return [`!${rel}`];
	}))].sort((a, b) => a.localeCompare(b));
}

function removeLegacyResearcherExtension(settings: Record<string, unknown>): void {
	const subagents = settings.subagents;
	const researcher = isRecord(subagents) && isRecord(subagents.agentOverrides) ? subagents.agentOverrides.researcher : undefined;
	if (!isRecord(researcher) || typeof researcher[LEGACY_RESEARCHER_EXTENSION_MARKER] !== "string") return;
	const managedPath = researcher[LEGACY_RESEARCHER_EXTENSION_MARKER];
	delete researcher[LEGACY_RESEARCHER_EXTENSION_MARKER];
	if (!Array.isArray(researcher.subagentOnlyExtensions)) return;
	const extensions = researcher.subagentOnlyExtensions.filter((entry) => entry !== managedPath);
	if (extensions.length > 0) researcher.subagentOnlyExtensions = extensions;
	else delete researcher.subagentOnlyExtensions;
}

function migrateAgentOverrideNames(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	let migrated: Record<string, unknown> | undefined;
	for (const [legacyName, currentName] of Object.entries(LEGACY_SUBAGENT_AGENT_NAMES)) {
		const overrides = migrated ?? value;
		const legacy = overrides[legacyName];
		if (!isRecord(legacy)) continue;
		const current = overrides[currentName];
		if (current !== undefined && !isRecord(current)) continue;
		migrated ??= { ...value };
		migrated[currentName] = isRecord(current) ? { ...legacy, ...current } : { ...legacy };
		delete migrated[legacyName];
	}
	return migrated ?? value;
}

function migrateSubagentOverrideNames(settings: Record<string, unknown>): void {
	const subagents = settings.subagents;
	if (!isRecord(subagents)) return;
	let updatedSubagents: Record<string, unknown> | undefined;

	const agentOverrides = migrateAgentOverrideNames(subagents.agentOverrides);
	if (agentOverrides && agentOverrides !== subagents.agentOverrides) {
		updatedSubagents = { ...subagents, agentOverrides };
	}

	const providerOverrides = subagents.agentOverridesByProvider;
	if (isRecord(providerOverrides)) {
		let updatedProviders: Record<string, unknown> | undefined;
		for (const [provider, overrides] of Object.entries(providerOverrides)) {
			const migrated = migrateAgentOverrideNames(overrides);
			if (!migrated || migrated === overrides) continue;
			updatedProviders ??= { ...providerOverrides };
			updatedProviders[provider] = migrated;
		}
		if (updatedProviders) {
			updatedSubagents ??= { ...subagents };
			updatedSubagents.agentOverridesByProvider = updatedProviders;
		}
	}

	if (updatedSubagents) settings.subagents = updatedSubagents;
}

function markSubagentAgentNamesMigrated(markerPath: string): void {
	try {
		writeFileSync(markerPath, "1\n", {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function waitForSettingsLockRelease(lockPath: string): Promise<void> {
	const watcher = watch(dirname(lockPath), { encoding: "utf8", persistent: false });
	let timeout: NodeJS.Timeout | undefined;
	let poller: NodeJS.Timeout | undefined;
	try {
		const changed = new Promise<void>((resolveChange, rejectChange) => {
			const resolveIfReleased = () => {
				if (!existsSync(lockPath)) resolveChange();
			};
			// fs.watch reports unlink as "rename" on several platforms and can
			// drop events under load, so poll as a fallback while the lock exists.
			watcher.on("change", resolveIfReleased);
			watcher.once("error", rejectChange);
			poller = setInterval(resolveIfReleased, 50);
			resolveIfReleased();
		});
		if (!existsSync(lockPath)) return;
		const timedOut = new Promise<never>((_resolveTimeout, rejectTimeout) => {
			timeout = setTimeout(
				() => rejectTimeout(new Error(
					`Timed out waiting for Hypatia settings lock at ${lockPath}. If no Hypatia startup is active, remove this stale lock file and retry.`,
				)),
				SETTINGS_LOCK_TIMEOUT_MS,
			);
		});
		await Promise.race([changed, timedOut]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (poller) clearInterval(poller);
		watcher.close();
	}
}

async function acquireHypatiaSettingsLock(settingsPath: string): Promise<() => void> {
	const lockPath = join(dirname(settingsPath), SETTINGS_LOCK_FILE);
	mkdirSync(dirname(settingsPath), { recursive: true });
	while (true) {
		const lockContents = `${process.pid}:${randomUUID()}\n`;
		try {
			writeFileSync(lockPath, lockContents, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return () => {
				try {
					if (readFileSync(lockPath, "utf8") === lockContents) unlinkSync(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await waitForSettingsLockRelease(lockPath);
	}
}

// Foreground subagents run inside the parent process and never load its
// extensions, so researcher and verifier lost web and paper search there.
// pi-subagents loads these paths in every child session; they are rewritten on
// each launch because the install path changes between versions.
export function hypatiaSubagentExtensions(appRoot: string): string[] {
	const webAccess = resolvePackageRoot(appRoot, "pi-web-access");
	return [join(appRoot, "extensions", "research-tools.ts"), ...(webAccess ? [webAccess] : [])];
}

function isHypatiaSubagentExtension(path: unknown): boolean {
	return typeof path === "string" && (/[\\/]extensions[\\/]research-tools\.ts$/.test(path) || /[\\/]pi-web-access$/.test(path));
}

async function ensureHypatiaSettingsContents(
	settingsPath: string,
	bundledSettingsPath: string,
	appRoot: string,
	defaultThinkingLevel: ThinkingLevel,
	authPath: string,
	workingDir: string,
	hideShadowedBundledSkills: boolean,
	migrationMarkerPath: string,
): Promise<void> {
	// Validate before model discovery or either settings write. Invalid custom
	// configuration must not silently turn into an empty/default configuration.
	const subagentDefaults = prepareSubagentDefaults(settingsPath);
	const migrateLegacyAgentNames = !existsSync(migrationMarkerPath);
	const existing = existsSync(settingsPath) ? readConfigObject(settingsPath, "Hypatia settings") : undefined;
	const settings: Record<string, unknown> = existing ? { ...existing.value } : {};
	const defaults = readConfigObject(bundledSettingsPath, "bundled Hypatia settings").value;

	for (const [key, value] of Object.entries({ ...defaults, defaultThinkingLevel })) {
		if (settings[key] === undefined) settings[key] = value;
	}
	const disabledHypatiaSkills = hideShadowedBundledSkills
		? await findShadowedHypatiaSkillPaths(settingsPath, appRoot, workingDir).catch(() => [])
		: [];
	settings.packages = reconcileHypatiaPackages(settings.packages, appRoot, disabledHypatiaSkills);
	if (migrateLegacyAgentNames) {
		removeLegacyResearcherExtension(settings);
		migrateSubagentOverrideNames(settings);
	}
	// 0.5.0-0.5.5 seeded a 6-retry, 5s backoff that left a dead connection
	// retrying silently for over five minutes; drop that exact value for Pi's default.
	if (isRecord(settings.retry) && JSON.stringify(settings.retry) === '{"maxRetries":6,"baseDelayMs":5000}') delete settings.retry;
	// A ~/.agents/<name>.md would otherwise silently replace Hypatia's agents.
	if (settings.subagents === undefined) settings.subagents = {};
	if (isRecord(settings.subagents) && settings.subagents.agentExcludeDirs === undefined) {
		settings.subagents.agentExcludeDirs = ["~/.agents"];
	}
	if (isRecord(settings.subagents)) {
		const current = settings.subagents.defaultSubagentOnlyExtensions;
		if (current === undefined || (Array.isArray(current) && current.every(isHypatiaSubagentExtension))) {
			settings.subagents.defaultSubagentOnlyExtensions = hypatiaSubagentExtensions(appRoot);
		}
	}

	if (!settings.defaultProvider || !settings.defaultModel) {
		const preferredModel = choosePreferredModelRecord(await getAvailableModelRecords(authPath));
		if (preferredModel) {
			settings.defaultProvider = preferredModel.provider;
			settings.defaultModel = preferredModel.id;
		}
	}

	// If another process wrote the subagent config while models were being
	// discovered, keep its version instead of overwriting it or failing startup.
	const subagentCurrent = subagentDefaults && existsSync(subagentDefaults.path) ? readFileSync(subagentDefaults.path, "utf8") : undefined;
	if (subagentDefaults && subagentCurrent === subagentDefaults.original) {
		mkdirSync(dirname(subagentDefaults.path), { recursive: true });
		try {
			writeFileSync(subagentDefaults.path, subagentDefaults.content, {
				encoding: "utf8", mode: 0o600, flag: subagentDefaults.original === undefined ? "wx" : "w",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const content = JSON.stringify(settings, null, 2) + "\n";
	// Model discovery can yield to another startup or a settings edit. Keep
	// that newer snapshot instead of restoring this process's stale copy.
	const currentSettingsSource = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
	if (currentSettingsSource === existing?.source) {
		if (content !== existing?.source) {
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, content, "utf8");
		}
		if (migrateLegacyAgentNames) markSubagentAgentNamesMigrated(migrationMarkerPath);
	}
}

export async function ensureHypatiaSettings(
	settingsPath: string,
	bundledSettingsPath: string,
	appRoot: string,
	defaultThinkingLevel: ThinkingLevel,
	authPath: string,
	workingDir = process.cwd(),
	hideShadowedBundledSkills = false,
): Promise<void> {
	const migrationMarkerPath = join(dirname(settingsPath), SUBAGENT_AGENT_NAME_MIGRATION_MARKER);
	const releaseSettingsLock = await acquireHypatiaSettingsLock(settingsPath);
	try {
		await ensureHypatiaSettingsContents(
			settingsPath,
			bundledSettingsPath,
			appRoot,
			defaultThinkingLevel,
			authPath,
			workingDir,
			hideShadowedBundledSkills,
			migrationMarkerPath,
		);
	} finally {
		releaseSettingsLock();
	}
}

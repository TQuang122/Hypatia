import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MODEL_API_KEY_PROVIDERS } from "../src/model/api-key-providers.js";
import {
	listOptionalPackagePresets,
	normalizeOptionalPackagePresetName,
	resolvePackageSource,
} from "../src/pi/packages.js";
import { BUNDLED_PI_PACKAGES, getHypatiaPackageSources } from "../src/pi/runtime.js";
import { chooseRecommendedModel } from "../src/model/catalog.js";
import { ensureHypatiaSettings, hypatiaSubagentExtensions, normalizeThinkingLevel } from "../src/pi/settings.js";

const appRoot = process.cwd();
const bundledSettingsPath = resolve(appRoot, ".hypatia", "settings.json");

async function withIsolatedProviderEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const envNames = new Set(MODEL_API_KEY_PROVIDERS.flatMap(({ envVar }) => envVar ? [envVar] : []));
	const original = new Map([...envNames].map((name) => [name, process.env[name]]));
	for (const name of envNames) delete process.env[name];
	try {
		return await run();
	} finally {
		for (const [name, value] of original) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("normalizeThinkingLevel accepts the latest Pi thinking levels", () => {
	assert.equal(normalizeThinkingLevel("off"), "off");
	assert.equal(normalizeThinkingLevel("minimal"), "minimal");
	assert.equal(normalizeThinkingLevel("low"), "low");
	assert.equal(normalizeThinkingLevel("medium"), "medium");
	assert.equal(normalizeThinkingLevel("high"), "high");
	assert.equal(normalizeThinkingLevel("xhigh"), "xhigh");
	assert.equal(normalizeThinkingLevel("max"), "max");
});

test("normalizeThinkingLevel rejects unknown values", () => {
	assert.equal(normalizeThinkingLevel("turbo"), undefined);
	assert.equal(normalizeThinkingLevel(undefined), undefined);
});

test("Azure API-key setup uses the provider ID expected by the installed Pi", () => {
	const azure = MODEL_API_KEY_PROVIDERS.find((provider) => provider.label.startsWith("Azure OpenAI"));
	assert.equal(azure?.id, "azure");
	assert.equal(azure?.envVar, "AZURE_OPENAI_API_KEY");
});

test("first run writes the bundled defaults and loads Hypatia plus its bundled Pi packages", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-first-run-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(join(root, "auth.json"), "{}\n");
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "high", join(root, "auth.json"));

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	const bundled = JSON.parse(readFileSync(bundledSettingsPath, "utf8"));
	assert.equal(settings.theme, "hypatia");
	for (const [key, value] of Object.entries(bundled)) assert.deepEqual(settings[key], value);
	assert.equal(settings.defaultThinkingLevel, "high");
	assert.deepEqual(settings.packages, getHypatiaPackageSources(appRoot));
	assert.equal(settings.packages[0], appRoot);
	assert.equal(settings.packages.length, 1 + BUNDLED_PI_PACKAGES.length);
});

test("legacy Azure provider config migrates auth, models, and the saved default without losing settings", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-azure-provider-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	const modelsPath = join(root, "models.json");
	writeFileSync(authPath, JSON.stringify({ "azure-openai-responses": { type: "api_key", key: "test-azure-key" } }));
	writeFileSync(modelsPath, JSON.stringify({ providers: {
		"azure-openai-responses": {
			baseUrl: "https://azure.example.com",
			api: "azure-openai-responses",
			models: [{ id: "deployment", name: "Deployment" }],
		},
	} }));
	const routesPath = join(root, "model-routes.json");
	writeFileSync(routesPath, JSON.stringify({ version: 1, roles: { auditor: ["azure-openai-responses/deployment"] } }));
	writeFileSync(settingsPath, JSON.stringify({
		defaultProvider: "azure-openai-responses",
		defaultModel: "deployment",
		quietStartup: true,
		subagents: {
			agentOverrides: { critic: { model: "azure-openai-responses/deployment" } },
			agentOverridesByProvider: {
				"openai-codex": { auditor: { model: "azure-openai-responses/deployment" } },
			},
		},
	}));

	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(settings.defaultProvider, "azure");
	assert.equal(settings.defaultModel, "deployment");
	assert.equal(settings.quietStartup, true);
	assert.equal(settings.subagents.agentOverrides.critic.model, "azure/deployment");
	assert.equal(settings.subagents.agentOverridesByProvider["openai-codex"].auditor.model, "azure/deployment");
	const auth = JSON.parse(readFileSync(authPath, "utf8"));
	assert.deepEqual(auth.azure, { type: "api_key", key: "test-azure-key" });
	assert.equal(Object.hasOwn(auth, "azure-openai-responses"), false);
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	assert.deepEqual(models.providers.azure, {
		baseUrl: "https://azure.example.com",
		api: "azure-openai-responses",
		models: [{ id: "deployment", name: "Deployment" }],
	});
	assert.equal(Object.hasOwn(models.providers, "azure-openai-responses"), false);
	assert.deepEqual(JSON.parse(readFileSync(routesPath, "utf8")), { version: 1, roles: { auditor: ["azure/deployment"] } });
});

test("Azure migration refuses conflicting provider entries without partially rewriting user files", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-azure-provider-conflict-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	const modelsPath = join(root, "models.json");
	writeFileSync(authPath, JSON.stringify({
		"azure-openai-responses": { type: "api_key", key: "legacy-key" },
		azure: { type: "api_key", key: "different-key" },
	}));
	writeFileSync(modelsPath, JSON.stringify({ providers: { "azure-openai-responses": { baseUrl: "https://legacy.example.com" } } }));
	writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "azure-openai-responses", defaultModel: "deployment" }));
	const before = [authPath, modelsPath, settingsPath].map((path) => readFileSync(path, "utf8"));

	await assert.rejects(
		ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath),
		/both.*azure.*auth\.json/i,
	);
	assert.deepEqual([authPath, modelsPath, settingsPath].map((path) => readFileSync(path, "utf8")), before);
});

test("Azure migration refuses routes that would become duplicate model choices", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-azure-route-conflict-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	const routesPath = join(root, "model-routes.json");
	writeFileSync(authPath, "{}\n");
	writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "azure-openai-responses", defaultModel: "deployment" }));
	writeFileSync(routesPath, JSON.stringify({
		version: 1,
		roles: { auditor: ["azure-openai-responses/deployment", "azure/deployment"] },
	}));
	const before = [authPath, settingsPath, routesPath].map((path) => readFileSync(path, "utf8"));

	await assert.rejects(
		ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath),
		/duplicate model routes in model-routes\.json/i,
	);
	assert.deepEqual([authPath, settingsPath, routesPath].map((path) => readFileSync(path, "utf8")), before);
});

test("later runs only add missing keys and leave an unchanged file alone", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-missing-keys-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(join(root, "auth.json"), "{}\n");
	writeFileSync(settingsPath, JSON.stringify({ theme: "dark", quietStartup: false, retry: { enabled: false } }));
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(settings.theme, "dark");
	assert.equal(settings.quietStartup, false);
	assert.deepEqual(settings.retry, { enabled: false });
	assert.equal(settings.collapseChangelog, true);
	assert.equal(settings.defaultThinkingLevel, "medium");

	const before = readFileSync(settingsPath, "utf8");
	const modifiedAt = statSync(settingsPath).mtimeMs;
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "low", join(root, "auth.json"));
	assert.equal(readFileSync(settingsPath, "utf8"), before);
	assert.equal(statSync(settingsPath).mtimeMs, modifiedAt);
});

test("pinned core packages from older releases become the bundled packages; custom packages stay", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-legacy-packages-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const oldInstall = join(root, "old-install", "node_modules", "pi-subagents");
	mkdirSync(oldInstall, { recursive: true });
	writeFileSync(join(oldInstall, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.65.1" }));
	writeFileSync(join(root, "auth.json"), "{}\n");
	writeFileSync(settingsPath, JSON.stringify({
		packages: [
			"npm:@companion-ai/alpha-hub@0.1.6",
			"npm:pi-subagents@0.65.1",
			"npm:pi-btw@0.4.1",
			"npm:pi-docparser@4.0.0",
			{ source: "npm:pi-web-access@0.28.0", skills: [] },
			"npm:pi-otel@0.1.0",
			"npm:@samfp/pi-memory",
			oldInstall,
			{ source: "git:github.com/example/custom@v1", prompts: [] },
		],
	}));
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));

	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, [
		...getHypatiaPackageSources(appRoot),
		"npm:@samfp/pi-memory",
		{ source: "git:github.com/example/custom@v1", prompts: [] },
	]);
});

test("user-level ~/.agents definitions cannot replace Hypatia's agents unless the user opts in", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-agent-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(join(root, "auth.json"), "{}\n");
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents, { agentExcludeDirs: ["~/.agents"], defaultSubagentOnlyExtensions: hypatiaSubagentExtensions(appRoot) });

	writeFileSync(settingsPath, JSON.stringify({ subagents: { agentExcludeDirs: [], agentOverrides: { scribe: { model: "x/y" } } } }));
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents, { agentExcludeDirs: [], agentOverrides: { scribe: { model: "x/y" } }, defaultSubagentOnlyExtensions: hypatiaSubagentExtensions(appRoot) });
});

test("legacy subagent override names migrate without losing canonical settings", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-agent-name-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, "{}\n");
	writeFileSync(settingsPath, JSON.stringify({
		subagents: {
			agentOverrides: {
				researcher: { model: "openai/legacy-research", tools: ["read"] },
				writer: { thinking: "medium" },
				verifier: { disabled: true },
				reviewer: { model: "openai/legacy-reviewer", thinking: "high" },
				patcher: { tools: ["read", "edit"] },
				"evidence-scout": { model: "openai/canonical-scout" },
			},
			agentOverridesByProvider: {
				"openai-codex": {
					researcher: { model: "openai-codex/legacy-research" },
					reviewer: { fast: true },
					"evidence-scout": { thinking: "low" },
				},
			},
		},
	}));

	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);

	const subagents = JSON.parse(readFileSync(settingsPath, "utf8")).subagents;
	assert.deepEqual(subagents.agentOverrides, {
		"evidence-scout": { model: "openai/canonical-scout", tools: ["read"] },
		scribe: { thinking: "medium" },
		auditor: { disabled: true },
		critic: { model: "openai/legacy-reviewer", thinking: "high" },
		reviser: { tools: ["read", "edit"] },
	});
	assert.deepEqual(subagents.agentOverridesByProvider, {
		"openai-codex": {
			"evidence-scout": { model: "openai-codex/legacy-research", thinking: "low" },
			critic: { fast: true },
		},
	});
});

test("later Pi builtin researcher and reviewer overrides remain under their original names", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-builtin-researcher-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, "{}\n");
	writeFileSync(settingsPath, JSON.stringify({
		subagents: {
			agentOverrides: {
				researcher: { model: "openai/legacy-hypatia-research" },
				reviewer: { model: "openai/legacy-hypatia-review" },
			},
			agentOverridesByProvider: {
				"openai-codex": {
					researcher: { model: "openai-codex/legacy-hypatia-research" },
					reviewer: { model: "openai-codex/legacy-hypatia-review" },
				},
			},
		},
	}));

	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);
	const migrated = JSON.parse(readFileSync(settingsPath, "utf8"));
	migrated.subagents.agentOverrides.researcher = { disabled: true };
	migrated.subagents.agentOverrides.reviewer = { disabled: true };
	migrated.subagents.agentOverridesByProvider["openai-codex"].researcher = { disabled: true };
	migrated.subagents.agentOverridesByProvider["openai-codex"].reviewer = { model: "openai-codex/builtin-review" };
	writeFileSync(settingsPath, JSON.stringify(migrated));

	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);

	const finalSettings = JSON.parse(readFileSync(settingsPath, "utf8")).subagents;
	assert.deepEqual(finalSettings.agentOverrides, {
		"evidence-scout": { model: "openai/legacy-hypatia-research" },
		critic: { model: "openai/legacy-hypatia-review" },
		researcher: { disabled: true },
		reviewer: { disabled: true },
	});
	assert.deepEqual(finalSettings.agentOverridesByProvider, {
		"openai-codex": {
			"evidence-scout": { model: "openai-codex/legacy-hypatia-research" },
			critic: { model: "openai-codex/legacy-hypatia-review" },
			researcher: { disabled: true },
			reviewer: { model: "openai-codex/builtin-review" },
		},
	});
});

test("stale startup snapshots do not overwrite a concurrent settings migration", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-concurrent-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, "{}\n");
	writeFileSync(settingsPath, JSON.stringify({
		subagents: { agentOverrides: { researcher: { model: "openai/legacy-hypatia-research" } } },
	}));

	const startup = ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath, root, true);
	const concurrentSettings = {
		subagents: {
			agentOverrides: {
				"evidence-scout": { model: "openai/legacy-hypatia-research" },
				researcher: { disabled: true },
			},
			agentOverridesByProvider: {
				"openai-codex": {
					"evidence-scout": { model: "openai-codex/legacy-hypatia-research" },
					researcher: { disabled: true },
				},
			},
		},
	};
	writeFileSync(settingsPath, JSON.stringify(concurrentSettings));
	writeFileSync(join(root, ".hypatia-agent-name-migration-v1"), "1\n");

	await startup;

	const persisted = JSON.parse(readFileSync(settingsPath, "utf8")).subagents;
	assert.deepEqual(persisted.agentOverrides, concurrentSettings.subagents.agentOverrides);
	assert.deepEqual(persisted.agentOverridesByProvider, concurrentSettings.subagents.agentOverridesByProvider);
});

test("startup waits for the active agent-name migration before reading settings", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-migration-lock-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "agent", "settings.json");
	const authPath = join(root, "agent", "auth.json");
	const markerName = ".hypatia-agent-name-migration-v1";
	const markerPath = join(root, "agent", markerName);
	const lockPath = join(root, "agent", ".hypatia-settings.lock");
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(authPath, "{}\n");
	writeFileSync(settingsPath, JSON.stringify({
		defaultProvider: "openai",
		defaultModel: "gpt-5.6-terra",
		subagents: { agentOverrides: { researcher: { model: "openai/legacy-hypatia-research" } } },
	}));
	writeFileSync(lockPath, "other-startup\n");

	const startup = ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);
	const settledBeforeMigration = await Promise.race([
		startup.then(() => true),
		new Promise<boolean>((resolveTurn) => setImmediate(() => resolveTurn(false))),
	]);
	assert.equal(settledBeforeMigration, false);

	writeFileSync(settingsPath, JSON.stringify({
		defaultProvider: "openai",
		defaultModel: "gpt-5.6-terra",
		subagents: {
			agentOverrides: {
				"evidence-scout": { model: "openai/legacy-hypatia-research" },
				researcher: { disabled: true },
			},
		},
	}));
	writeFileSync(markerPath, "1\n");
	unlinkSync(lockPath);

	let startupTimeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			startup,
			new Promise<never>((_resolveStartup, rejectStartup) => {
				startupTimeout = setTimeout(() => rejectStartup(new Error("Settings startup did not resume after migration lock release")), 3_000);
			}),
		]);
	} finally {
		if (startupTimeout) clearTimeout(startupTimeout);
	}

	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides, {
		"evidence-scout": { model: "openai/legacy-hypatia-research" },
		researcher: { disabled: true },
	});
});

test("startup locks settings updates after the migration marker exists", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-existing-marker-lock-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settingsPath = join(agentDir, "settings.json");
	const authPath = join(agentDir, "auth.json");
	const markerPath = join(agentDir, ".hypatia-agent-name-migration-v1");
	const lockPath = join(agentDir, ".hypatia-settings.lock");
	writeFileSync(authPath, "{}\n");
	writeFileSync(markerPath, "1\n");
	writeFileSync(settingsPath, JSON.stringify({
		defaultProvider: "openai",
		defaultModel: "gpt-5.6-terra",
		subagents: { agentOverrides: { researcher: { model: "openai/builtin-research" } } },
	}));
	writeFileSync(lockPath, "other-startup\n");

	const startup = ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);
	const startupFinished = startup.then(() => undefined);
	const settledBeforeRelease = await Promise.race([
		startupFinished.then(() => true),
		new Promise<boolean>((resolveTurn) => setImmediate(() => resolveTurn(false))),
	]);
	assert.equal(settledBeforeRelease, false);

	writeFileSync(settingsPath, JSON.stringify({
		defaultProvider: "openai",
		defaultModel: "gpt-5.6-terra",
		subagents: { agentOverrides: { researcher: { disabled: true } } },
	}));
	unlinkSync(lockPath);

	let startupTimeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			startupFinished,
			new Promise<never>((_resolveStartup, rejectStartup) => {
				startupTimeout = setTimeout(() => rejectStartup(new Error("Settings startup lock timed out")), 3_000);
			}),
		]);
	} finally {
		if (startupTimeout) clearTimeout(startupTimeout);
	}

	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides, {
		researcher: { disabled: true },
	});
});

test("the researcher child extension path managed by older releases is removed", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-researcher-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(join(root, "auth.json"), "{}\n");
	writeFileSync(settingsPath, JSON.stringify({
		subagents: { agentOverrides: {
			researcher: { subagentOnlyExtensions: ["custom.ts", "/old/extensions/research-tools.ts"], _hypatiaResearchToolsExtension: "/old/extensions/research-tools.ts" },
			writer: { subagentOnlyExtensions: ["/old/extensions/research-tools.ts"] },
		} },
	}));
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));

	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides, {
		"evidence-scout": { subagentOnlyExtensions: ["custom.ts"] },
		scribe: { subagentOnlyExtensions: ["/old/extensions/research-tools.ts"] },
	});
});

test("subagent defaults follow settingsPath, not HOME, authPath, or the Pi environment", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-defaults-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "custom", "agent");
	const decoyDir = join(root, "unrelated-agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(decoyDir);
	const settingsPath = join(agentDir, "settings.json");
	const authPath = join(decoyDir, "auth.json");
	writeFileSync(authPath, "{}\n");
	const keys = ["HOME", "PI_CODING_AGENT_DIR"] as const;
	const previous = keys.map((key) => process.env[key]);
	for (const key of keys) process.env[key] = decoyDir;
	try {
		await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);
	} finally {
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
	}
	const configPath = join(agentDir, "extensions", "subagent", "config.json");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		missions: { enabled: false }, fleetView: false, asyncByDefault: true, singleRunOutputBaseDir: ".",
	});
	assert.equal(statSync(configPath).mode & 0o777, 0o600);
	assert.equal(existsSync(join(decoyDir, "extensions")), false);
	const before = readFileSync(configPath, "utf8");
	const modifiedAt = statSync(configPath).mtimeMs;
	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);
	assert.equal(readFileSync(configPath, "utf8"), before);
	assert.equal(statSync(configPath).mtimeMs, modifiedAt);
});

test("subagent defaults preserve explicit custom values and complete config bytes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-custom-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configPath = join(root, "extensions", "subagent", "config.json");
	mkdirSync(join(root, "extensions", "subagent"), { recursive: true });
	const original = '{"missions":{"enabled":true,"globalIndex":false},"fleetView":true,"asyncByDefault":false,"singleRunOutputBaseDir":"~/research-out","maxSubagentDepth":1}\n';
	writeFileSync(configPath, original, { mode: 0o640 });
	writeFileSync(join(root, "auth.json"), "{}\n");
	await ensureHypatiaSettings(join(root, "settings.json"), bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));
	assert.equal(readFileSync(configPath, "utf8"), original);
	assert.equal(statSync(configPath).mode & 0o777, 0o640);
});

test("subagent defaults merge only missing fields while preserving nested config and false values", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-partial-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configPath = join(root, "extensions", "subagent", "config.json");
	mkdirSync(join(root, "extensions", "subagent"), { recursive: true });
	writeFileSync(configPath, JSON.stringify({
		missions: { directory: join(root, "custom-missions"), retainTerminal: 12 },
		asyncByDefault: false, asyncWidget: true, custom: { nested: ["preserved"] },
	}));
	writeFileSync(join(root, "auth.json"), "{}\n");
	await ensureHypatiaSettings(join(root, "settings.json"), bundledSettingsPath, appRoot, "medium", join(root, "auth.json"));
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		missions: { directory: join(root, "custom-missions"), retainTerminal: 12, enabled: false },
		asyncByDefault: false, asyncWidget: true, custom: { nested: ["preserved"] }, fleetView: false,
		singleRunOutputBaseDir: ".",
	});
});

for (const invalid of [
	"{", "null", "[]", "false", '"string"',
	'{"missions":null}', '{"missions":[]}', '{"missions":false}',
	'{"missions":{"enabled":"false"}}', '{"missions":{"enabled":null}}',
	'{"fleetView":0}', '{"fleetView":null}', '{"asyncByDefault":"true"}', '{"asyncByDefault":null}',
	'{"singleRunOutputBaseDir":1}',
]) {
	test(`subagent defaults reject invalid config without rewriting any settings: ${invalid}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-invalid-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const configPath = join(root, "extensions", "subagent", "config.json");
		const settingsPath = join(root, "settings.json");
		mkdirSync(join(root, "extensions", "subagent"), { recursive: true });
		writeFileSync(configPath, invalid);
		const settings = '{"subagents":{"agentOverrides":{"evidence-scout":{"subagentOnlyExtensions":["custom.ts"]}}}}\n';
		writeFileSync(settingsPath, settings);
		await assert.rejects(
			ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "absent-auth.json")),
			/Invalid subagent config/,
		);
		assert.equal(readFileSync(configPath, "utf8"), invalid);
		assert.equal(readFileSync(settingsPath, "utf8"), settings);
		assert.equal(existsSync(join(root, "absent-auth.json")), false);
	});
}

test("invalid main settings fail closed before creating subagent defaults", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-invalid-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(settingsPath, "{");
	await assert.rejects(
		ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", join(root, "absent-auth.json")),
		/Invalid Hypatia settings/,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), "{");
	assert.equal(existsSync(join(root, "extensions")), false);
});

test("ensureHypatiaSettings seeds the newest OpenAI GPT default exposed by Pi", async () => withIsolatedProviderEnvironment(async () => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-"));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");

	writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "openai-test-key" } }) + "\n", "utf8");
	const recommendation = await chooseRecommendedModel(authPath);

	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);

	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
		defaultProvider?: string;
		defaultModel?: string;
	};
	assert.equal(`${settings.defaultProvider}/${settings.defaultModel}`, recommendation?.spec);
}));

test("ensureHypatiaSettings seeds OpenCode Go Kimi as the preferred OpenCode Go default", async () => withIsolatedProviderEnvironment(async () => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-"));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");

	writeFileSync(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "opencode-test-key" } }) + "\n", "utf8");

	await ensureHypatiaSettings(settingsPath, bundledSettingsPath, appRoot, "medium", authPath);

	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
		defaultProvider?: string;
		defaultModel?: string;
	};
	assert.equal(settings.defaultProvider, "opencode-go");
	assert.equal(settings.defaultModel, "kimi-k2.7-code");
}));

test("optional package presets map friendly names to Pi package sources", () => {
	assert.equal(resolvePackageSource("memory"), "npm:@samfp/pi-memory");
	assert.equal(resolvePackageSource("Hindsight"), "npm:@luxusai/pi-hindsight");
	assert.equal(resolvePackageSource("session-search"), "session-search");
	assert.equal(resolvePackageSource("npm:custom-package"), "npm:custom-package");
	assert.equal(normalizeOptionalPackagePresetName("all-extras"), undefined);
	assert.deepEqual(listOptionalPackagePresets().map((preset) => preset.name), ["memory", "hindsight"]);
});


test("ensureHypatiaSettings drops the retry backoff older Hypatia versions seeded", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-settings-retry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, "{}\n");
	writeFileSync(settingsPath, JSON.stringify({ retry: { maxRetries: 6, baseDelayMs: 5000 }, defaultProvider: "openai", defaultModel: "gpt-5.6-terra" }));
	await ensureHypatiaSettings(settingsPath, resolve(".hypatia", "settings.json"), process.cwd(), "medium", authPath);
	assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).retry, undefined);

	writeFileSync(settingsPath, JSON.stringify({ retry: { maxRetries: 8 }, defaultProvider: "openai", defaultModel: "gpt-5.6-terra" }));
	await ensureHypatiaSettings(settingsPath, resolve(".hypatia", "settings.json"), process.cwd(), "medium", authPath);
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).retry, { maxRetries: 8 });
});

test("concurrent Hypatia starts share one subagent config instead of failing", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-race-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "agent", "settings.json");
	const authPath = join(root, "agent", "auth.json");
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(authPath, "{}\n");
	// Both calls read the missing config, then await model discovery before writing.
	await Promise.all([
		ensureHypatiaSettings(settingsPath, resolve(".hypatia", "settings.json"), process.cwd(), "medium", authPath),
		ensureHypatiaSettings(settingsPath, resolve(".hypatia", "settings.json"), process.cwd(), "medium", authPath),
	]);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "agent", "extensions", "subagent", "config.json"), "utf8")), {
		missions: { enabled: false }, fleetView: false, asyncByDefault: true, singleRunOutputBaseDir: ".",
	});
});

test("ensureHypatiaSettings gives every subagent Hypatia's research and web tools", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-extensions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "agent", "settings.json");
	const authPath = join(root, "agent", "auth.json");
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(authPath, "{}\n");
	const read = () => JSON.parse(readFileSync(settingsPath, "utf8")).subagents.defaultSubagentOnlyExtensions;
	const expected = hypatiaSubagentExtensions(process.cwd());
	assert.deepEqual(expected, [join(process.cwd(), "extensions", "research-tools.ts"), join(process.cwd(), "node_modules", "pi-web-access")]);

	writeFileSync(settingsPath, JSON.stringify({ subagents: { defaultSubagentOnlyExtensions: ["/old/hypatia-0.5.1/extensions/research-tools.ts", "/old/hypatia-0.5.1/node_modules/pi-web-access"] }, defaultProvider: "openai", defaultModel: "gpt-5.6-terra" }));
	await ensureHypatiaSettings(settingsPath, resolve(".hypatia", "settings.json"), process.cwd(), "medium", authPath);
	assert.deepEqual(read(), expected);

	writeFileSync(settingsPath, JSON.stringify({ subagents: { defaultSubagentOnlyExtensions: ["/mine/tool.ts"] }, defaultProvider: "openai", defaultModel: "gpt-5.6-terra" }));
	await ensureHypatiaSettings(settingsPath, resolve(".hypatia", "settings.json"), process.cwd(), "medium", authPath);
	assert.deepEqual(read(), ["/mine/tool.ts"]);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	clearSubagentModelOverride,
	getConfiguredParentModel,
	getSubagentModelOverride,
	getSubagentThinkingOverride,
	parseSubagentModelRoutes,
	readSubagentModelRoutes,
	readSubagentModelSettings,
	resolveSubagentModelRoutes,
	setSubagentThinkingOverride,
	writeSubagentModelRoutes,
} from "../src/model/role-routing.js";
import { getSubagentModelRoutes } from "../extensions/research-tools/subagent-models.js";
import { runSubagentModelRoutesDialog } from "../extensions/research-tools/model-routes.js";

function routeDialogContext(selections: Array<number | undefined>) {
	const notifications: string[] = [];
	return {
		context: {
			hasUI: true,
			ui: {
				select: async (_title: string, options: string[]) => {
					const selection = selections.shift();
					return selection === undefined ? undefined : options[selection];
				},
				notify: (message: string) => notifications.push(message),
			},
		},
		notifications,
	};
}

test("parseSubagentModelRoutes preserves each role's ordered model candidates", () => {
	const routes = parseSubagentModelRoutes({
		version: 1,
		roles: {
			"evidence-scout": ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-5-5"],
			auditor: ["anthropic/claude-opus-5-5"],
			reviser: ["anthropic/claude-sonnet-5-5"],
		},
	});

	assert.deepEqual(routes, {
		version: 1,
		roles: {
			"evidence-scout": ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-5-5"],
			auditor: ["anthropic/claude-opus-5-5"],
			reviser: ["anthropic/claude-sonnet-5-5"],
		},
	});
});

test("parseSubagentModelRoutes migrates legacy role keys and prefers canonical keys", () => {
	assert.deepEqual(parseSubagentModelRoutes({
		version: 1,
		roles: {
			researcher: ["openai/legacy-research"],
			"evidence-scout": ["openai/evidence-scout"],
			writer: ["openai/writer"],
			verifier: ["openai/verifier"],
			reviewer: ["openai/reviewer"],
			patcher: ["openai/patcher"],
		},
	}), {
		version: 1,
		roles: {
			"evidence-scout": ["openai/evidence-scout"],
			scribe: ["openai/writer"],
			auditor: ["openai/verifier"],
			critic: ["openai/reviewer"],
			reviser: ["openai/patcher"],
		},
	});
});

for (const invalid of [
	null,
	[],
	{ version: 2, roles: {} },
	{ version: 1, roles: { scout: ["openai/gpt-5.6-luna"] } },
	{ version: 1, roles: { "evidence-scout": "openai/gpt-5.6-luna" } },
	{ version: 1, roles: { "evidence-scout": ["gpt-5.6-luna"] } },
	{ version: 1, roles: { "evidence-scout": ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"] } },
]) {
	test(`parseSubagentModelRoutes rejects invalid role routes: ${JSON.stringify(invalid)}`, () => {
		assert.throws(() => parseSubagentModelRoutes(invalid), /Invalid subagent model routes/);
	});
}

test("readSubagentModelRoutes treats a missing config file as no explicit routes", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-routes-missing-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	assert.deepEqual(readSubagentModelRoutes(join(root, "model-routes.json")), { version: 1, roles: {} });
});

test("readSubagentModelRoutes rejects malformed JSON without silently dropping the routes", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-routes-invalid-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "model-routes.json");
	writeFileSync(path, "{");

	assert.throws(() => readSubagentModelRoutes(path), /Invalid subagent model routes/);
});

test("readSubagentModelSettings reads native Pi role overrides", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	writeFileSync(path, JSON.stringify({
		subagents: { agentOverrides: { critic: { model: "anthropic/claude-opus-5-5" } } },
	}));

	assert.deepEqual(readSubagentModelSettings(path), {
		subagents: { agentOverrides: { critic: { model: "anthropic/claude-opus-5-5" } } },
	});
});

test("readSubagentModelSettings treats a missing Pi settings file as empty", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-settings-missing-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	assert.deepEqual(readSubagentModelSettings(join(root, "settings.json")), {});
});

test("role model settings distinguish a Pi override from parent inheritance", () => {
	assert.equal(
		getSubagentModelOverride({
			subagents: { agentOverrides: { "evidence-scout": { model: "openai-codex/gpt-5.6-terra" } } },
		}, "evidence-scout"),
		"openai-codex/gpt-5.6-terra",
	);
	assert.equal(
		getSubagentModelOverride({
			subagents: { agentOverrides: { "evidence-scout": { model: "inherit" } } },
		}, "evidence-scout"),
		undefined,
	);
	assert.equal(
		getConfiguredParentModel({ defaultProvider: "openai-codex", defaultModel: "gpt-6-luna" }),
		"openai-codex/gpt-6-luna",
	);
	assert.equal(getConfiguredParentModel({ defaultProvider: "openai-codex" }), undefined);
});

test("resolveSubagentModelRoutes uses configured chains before native Pi role pins", () => {
	const routes = parseSubagentModelRoutes({
		version: 1,
		roles: {
			"evidence-scout": ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"],
			reviser: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.6-terra"],
		},
	});

	assert.deepEqual(
		resolveSubagentModelRoutes(routes, {
			subagents: {
				agentOverrides: {
					"evidence-scout": { model: "anthropic/claude-sonnet-5-5" },
					critic: { model: "anthropic/claude-opus-5-5" },
					reviser: { model: "openai/gpt-5.6-terra" },
				},
			},
		}),
		{
			"evidence-scout": {
				models: ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"],
				source: "model-routes",
			},
			scribe: { models: [], source: "inherit" },
			auditor: { models: [], source: "inherit" },
			critic: { models: ["anthropic/claude-opus-5-5"], source: "pi-settings" },
			reviser: {
				models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.6-terra"],
				source: "model-routes",
			},
		},
	);
});

test("getSubagentModelRoutes reads explicit chains and Pi role overrides from the agent directory", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-routes-tool-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "model-routes.json"), JSON.stringify({
		version: 1,
		roles: {
			"evidence-scout": ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"],
			reviser: ["anthropic/claude-sonnet-5-5"],
		},
	}));
	writeFileSync(join(root, "settings.json"), JSON.stringify({
		subagents: {
			agentOverrides: {
				critic: { model: "anthropic/claude-opus-5-5" },
				reviser: { model: "openai/gpt-5.6-terra" },
			},
		},
	}));

	assert.deepEqual(getSubagentModelRoutes(root), {
		"evidence-scout": { models: ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"], source: "model-routes" },
		scribe: { models: [], source: "inherit" },
		auditor: { models: [], source: "inherit" },
		critic: { models: ["anthropic/claude-opus-5-5"], source: "pi-settings" },
		reviser: { models: ["anthropic/claude-sonnet-5-5"], source: "model-routes" },
	});
});

test("writeSubagentModelRoutes persists ordered model choices for editing", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-routes-write-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "agent", "model-routes.json");
	const routes = {
		version: 1,
		roles: {
			"evidence-scout": ["openai-codex/gpt-6-luna", "openai-codex/gpt-5.6-terra"],
			reviser: ["anthropic/claude-sonnet-5-5"],
		},
	};

	writeSubagentModelRoutes(path, routes);

	assert.deepEqual(readSubagentModelRoutes(path), routes);
});

test("writeSubagentModelRoutes rejects invalid choices without replacing saved routes", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-model-routes-write-invalid-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "model-routes.json");
	const saved = {
		version: 1,
		roles: { auditor: ["openai-codex/gpt-6-luna"] },
	};
	writeFileSync(path, JSON.stringify(saved) + "\n");

	assert.throws(() => writeSubagentModelRoutes(path, {
		version: 1,
		roles: { auditor: ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-luna"] },
	}), /Invalid subagent model routes/);
	assert.deepEqual(readSubagentModelRoutes(path), saved);
});

test("per-role thinking overrides persist in Pi settings and clear without losing other fields", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-subagent-thinking-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ subagents: { defaultThinking: "medium", agentOverrides: {
		"evidence-scout": { model: "openai-codex/gpt-6-luna", fast: true }, critic: { thinking: "low" },
	} } }));

	setSubagentThinkingOverride(settingsPath, "evidence-scout", "xhigh");
	let settings = readSubagentModelSettings(settingsPath);
	assert.equal(getSubagentThinkingOverride(settings, "evidence-scout"), "xhigh");
	assert.equal(getSubagentThinkingOverride(settings, "critic"), "low");
	assert.equal((settings.subagents as any).agentOverrides["evidence-scout"].model, "openai-codex/gpt-6-luna");

	setSubagentThinkingOverride(settingsPath, "evidence-scout", undefined);
	settings = readSubagentModelSettings(settingsPath);
	assert.equal(getSubagentThinkingOverride(settings, "evidence-scout"), undefined);
	assert.deepEqual((settings.subagents as any).agentOverrides["evidence-scout"], { model: "openai-codex/gpt-6-luna", fast: true });
	assert.equal((settings.subagents as any).defaultThinking, "medium");
	setSubagentThinkingOverride(settingsPath, "evidence-scout", false);
	assert.equal(getSubagentThinkingOverride(readSubagentModelSettings(settingsPath), "evidence-scout"), false);
});

test("model-routes dialog selects and clears a role-specific thinking level", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-chat-thinking-routes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const settingsPath = join(root, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ subagents: { agentOverrides: { "evidence-scout": { model: "openai-codex/gpt-6-luna" } } } }));
	const first = routeDialogContext([0, 1, 6, 5]);
	await runSubagentModelRoutesDialog(first.context, root, []);
	assert.equal(getSubagentThinkingOverride(readSubagentModelSettings(settingsPath), "evidence-scout"), "high");
	assert.match(first.notifications.at(-1) ?? "", /thinking set to high/u);

	const second = routeDialogContext([0, 1, 0, 5]);
	await runSubagentModelRoutesDialog(second.context, root, []);
	assert.equal(getSubagentThinkingOverride(readSubagentModelSettings(settingsPath), "evidence-scout"), undefined);
	assert.deepEqual((readSubagentModelSettings(settingsPath).subagents as any).agentOverrides["evidence-scout"], { model: "openai-codex/gpt-6-luna" });
});

test("model routes provides structured inspection without requiring a TTY", (t) => {
	const workingDir = mkdtempSync(join(tmpdir(), "hypatia-model-routes-cli-cwd-"));
	const homeDir = mkdtempSync(join(tmpdir(), "hypatia-model-routes-cli-home-"));
	t.after(() => {
		rmSync(workingDir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
	});
	const result = spawnSync(process.execPath, [
		"--import",
		"tsx",
		resolve("src/index.ts"),
		"--cwd",
		workingDir,
		"model",
		"routes",
		"--json",
	], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, HYPATIA_HOME: homeDir, HYPATIA_TELEMETRY: "0" },
		maxBuffer: 1024 * 1024,
	});

	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(output.schema, "hypatia.subagentModelRoutes.v1");
	assert.deepEqual(output.roles["evidence-scout"], { models: [], source: "inherit" });
	assert.deepEqual(output.roles.reviser, { models: [], source: "inherit" });
});

test("model routes rejects non-interactive editing without creating a route file", (t) => {
	const workingDir = mkdtempSync(join(tmpdir(), "hypatia-model-routes-no-tty-cwd-"));
	const homeDir = mkdtempSync(join(tmpdir(), "hypatia-model-routes-no-tty-home-"));
	t.after(() => {
		rmSync(workingDir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
	});
	const routePath = join(homeDir, ".hypatia", "agent", "model-routes.json");
	const result = spawnSync(process.execPath, [
		"--import",
		"tsx",
		resolve("src/index.ts"),
		"--cwd",
		workingDir,
		"model",
		"routes",
	], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, HYPATIA_HOME: homeDir, HYPATIA_TELEMETRY: "0" },
		maxBuffer: 1024 * 1024,
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Route editing requires an interactive terminal/);
	assert.equal(existsSync(routePath), false);
});

test("chat model route editor saves primary and fallback selections in order", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-chat-model-routes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const routePath = join(root, "model-routes.json");
	const { context } = routeDialogContext([0, 0, 1, 1, 0, 5]);

	await runSubagentModelRoutesDialog(context, root, [
		{ provider: "openai-codex", id: "gpt-5.6-terra" },
		{ provider: "openai-codex", id: "gpt-6-luna" },
	]);

	assert.deepEqual(readSubagentModelRoutes(routePath), {
		version: 1,
		roles: {
			"evidence-scout": ["openai-codex/gpt-6-luna", "openai-codex/gpt-5.6-terra"],
		},
	});
});

test("chat model route editor preserves Pi override when selected", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-chat-model-routes-inherit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const routePath = join(root, "model-routes.json");
	const settingsPath = join(root, "settings.json");
	writeSubagentModelRoutes(routePath, {
		version: 1,
		roles: { "evidence-scout": ["openai-codex/gpt-6-luna"] },
	});
	writeFileSync(settingsPath, JSON.stringify({
		subagents: {
			agentOverrides: {
				"evidence-scout": { model: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" },
			},
		},
	}));
	const { context } = routeDialogContext([0, 2, 5]);

	await runSubagentModelRoutesDialog(context, root, [], "openai-codex/gpt-6-luna");

	assert.deepEqual(readSubagentModelRoutes(routePath), { version: 1, roles: {} });
	assert.deepEqual(readSubagentModelSettings(settingsPath), {
		subagents: {
			agentOverrides: {
				"evidence-scout": { model: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" },
			},
		},
	});
	assert.equal(getSubagentModelOverride(readSubagentModelSettings(settingsPath), "evidence-scout"), "openai-codex/gpt-5.6-terra");
});

test("chat model route editor clears both overrides to inherit the parent model", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-chat-model-routes-parent-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const routePath = join(root, "model-routes.json");
	const settingsPath = join(root, "settings.json");
	writeSubagentModelRoutes(routePath, {
		version: 1,
		roles: { "evidence-scout": ["openai-codex/gpt-6-luna"] },
	});
	writeFileSync(settingsPath, JSON.stringify({
		defaultProvider: "openai-codex",
		defaultModel: "gpt-6-luna",
		subagents: {
			agentOverrides: {
				"evidence-scout": { model: "openai-codex/gpt-5.6-terra", thinkingLevel: "high" },
				auditor: { model: "anthropic/claude-opus-5-5" },
			},
		},
	}));
	const { context } = routeDialogContext([0, 3, 5]);

	await runSubagentModelRoutesDialog(context, root, [], "openai-codex/gpt-6-luna");

	assert.deepEqual(readSubagentModelRoutes(routePath), { version: 1, roles: {} });
	assert.deepEqual(readSubagentModelSettings(settingsPath), {
		defaultProvider: "openai-codex",
		defaultModel: "gpt-6-luna",
		subagents: {
			agentOverrides: {
				"evidence-scout": { thinkingLevel: "high" },
				auditor: { model: "anthropic/claude-opus-5-5" },
			},
		},
	});
	assert.equal(getSubagentModelOverride(readSubagentModelSettings(settingsPath), "evidence-scout"), undefined);
	clearSubagentModelOverride(settingsPath, "auditor");
	assert.deepEqual(readSubagentModelSettings(settingsPath).subagents, { agentOverrides: { "evidence-scout": { thinkingLevel: "high" } } });
});

test("chat model route editor leaves the saved route unchanged on cancellation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-chat-model-routes-cancel-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const routePath = join(root, "model-routes.json");
	const saved = { version: 1, roles: { critic: ["anthropic/claude-opus-5-5"] } };
	writeSubagentModelRoutes(routePath, saved);
	const { context } = routeDialogContext([0, undefined]);

	await runSubagentModelRoutesDialog(context, root, []);

	assert.deepEqual(readSubagentModelRoutes(routePath), saved);
});

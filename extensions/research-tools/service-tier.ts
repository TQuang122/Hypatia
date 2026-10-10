import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const HYPATIA_SERVICE_TIERS = [
	"auto",
	"default",
	"flex",
	"priority",
	"standard_only",
] as const;

type HypatiaServiceTier = (typeof HYPATIA_SERVICE_TIERS)[number];

const SERVICE_TIER_SET = new Set<string>(HYPATIA_SERVICE_TIERS);
const OPENAI_SERVICE_TIERS = new Set<HypatiaServiceTier>(["auto", "default", "flex", "priority"]);
const ANTHROPIC_SERVICE_TIERS = new Set<HypatiaServiceTier>(["auto", "standard_only"]);

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

type SelectOption<T> = {
	label: string;
	value: T;
};

function resolveHypatiaSettingsPath(): string {
	return resolve(getAgentDir(), "settings.json");
}

function normalizeServiceTier(value: string | undefined): HypatiaServiceTier | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return SERVICE_TIER_SET.has(normalized) ? (normalized as HypatiaServiceTier) : undefined;
}

function getConfiguredServiceTier(settingsPath: string): HypatiaServiceTier | undefined {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { serviceTier?: string };
		return normalizeServiceTier(parsed.serviceTier);
	} catch {
		return undefined;
	}
}

function setConfiguredServiceTier(settingsPath: string, tier: HypatiaServiceTier | undefined): void {
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {}

	if (tier) {
		settings.serviceTier = tier;
	} else {
		delete settings.serviceTier;
	}

	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function resolveActiveServiceTier(settingsPath: string): HypatiaServiceTier | undefined {
	return normalizeServiceTier(process.env.HYPATIA_SERVICE_TIER) ?? getConfiguredServiceTier(settingsPath);
}

function resolveProviderServiceTier(
	provider: string | undefined,
	tier: HypatiaServiceTier | undefined,
): HypatiaServiceTier | undefined {
	if (!provider || !tier) return undefined;
	if ((provider === "openai" || provider === "openai-codex") && OPENAI_SERVICE_TIERS.has(tier)) {
		return tier;
	}
	if (provider === "anthropic" && ANTHROPIC_SERVICE_TIERS.has(tier)) {
		return tier;
	}
	return undefined;
}

async function selectOption<T>(
	ctx: CommandContext,
	title: string,
	options: SelectOption<T>[],
): Promise<T | undefined> {
	const selected = await ctx.ui.select(
		title,
		options.map((option) => option.label),
	);
	if (!selected) return undefined;
	return options.find((option) => option.label === selected)?.value;
}

function parseRequestedTier(rawArgs: string): HypatiaServiceTier | null | undefined {
	const trimmed = rawArgs.trim();
	if (!trimmed) return undefined;
	if (trimmed === "unset" || trimmed === "clear" || trimmed === "off") return null;
	return normalizeServiceTier(trimmed);
}

export function registerServiceTierControls(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.model || !event.payload || typeof event.payload !== "object") {
			return;
		}

		const activeTier = resolveActiveServiceTier(resolveHypatiaSettingsPath());
		const providerTier = resolveProviderServiceTier(ctx.model.provider, activeTier);
		if (!providerTier) {
			return;
		}

		return {
			...(event.payload as Record<string, unknown>),
			service_tier: providerTier,
		};
	});

	pi.registerCommand("service-tier", {
		description: "View or set the provider service tier override used for supported models.",
		handler: async (args, ctx) => {
			const settingsPath = resolveHypatiaSettingsPath();
			const requested = parseRequestedTier(args);

			if (requested === undefined && !args.trim()) {
				if (!ctx.hasUI) {
					ctx.ui.notify(getConfiguredServiceTier(settingsPath) ?? "not set", "info");
					return;
				}

				const current = getConfiguredServiceTier(settingsPath);
				const selected = await selectOption(
					ctx,
					"Select service tier",
					[
						{ label: current ? `unset (current: ${current})` : "unset (current)", value: null },
						...HYPATIA_SERVICE_TIERS.map((tier) => ({
							label: tier === current ? `${tier} (current)` : tier,
							value: tier,
						})),
					],
				);
				if (selected === undefined) return;
				if (selected === null) {
					setConfiguredServiceTier(settingsPath, undefined);
					ctx.ui.notify("Cleared service tier override.", "info");
					return;
				}
				setConfiguredServiceTier(settingsPath, selected);
				ctx.ui.notify(`Service tier set to ${selected}.`, "info");
				return;
			}

			if (requested === null) {
				setConfiguredServiceTier(settingsPath, undefined);
				ctx.ui.notify("Cleared service tier override.", "info");
				return;
			}

			if (!requested) {
				ctx.ui.notify("Use auto, default, flex, priority, standard_only, or unset.", "error");
				return;
			}

			setConfiguredServiceTier(settingsPath, requested);
			ctx.ui.notify(`Service tier set to ${requested}.`, "info");
		},
	});
}

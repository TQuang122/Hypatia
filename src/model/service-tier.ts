import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const HYPATIA_SERVICE_TIERS = [
	"auto",
	"default",
	"flex",
	"priority",
	"standard_only",
] as const;

export type HypatiaServiceTier = (typeof HYPATIA_SERVICE_TIERS)[number];

const SERVICE_TIER_SET = new Set<string>(HYPATIA_SERVICE_TIERS);
const OPENAI_SERVICE_TIERS = new Set<HypatiaServiceTier>(["auto", "default", "flex", "priority"]);
const ANTHROPIC_SERVICE_TIERS = new Set<HypatiaServiceTier>(["auto", "standard_only"]);

function readSettings(settingsPath: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export function normalizeServiceTier(value: string | undefined): HypatiaServiceTier | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return SERVICE_TIER_SET.has(normalized) ? (normalized as HypatiaServiceTier) : undefined;
}

export function getConfiguredServiceTier(settingsPath: string): HypatiaServiceTier | undefined {
	const settings = readSettings(settingsPath);
	return normalizeServiceTier(typeof settings.serviceTier === "string" ? settings.serviceTier : undefined);
}

export function setConfiguredServiceTier(settingsPath: string, tier: HypatiaServiceTier | undefined): void {
	const settings = readSettings(settingsPath);
	if (tier) {
		settings.serviceTier = tier;
	} else {
		delete settings.serviceTier;
	}

	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function resolveActiveServiceTier(settingsPath: string): HypatiaServiceTier | undefined {
	return normalizeServiceTier(process.env.HYPATIA_SERVICE_TIER) ?? getConfiguredServiceTier(settingsPath);
}

export function resolveProviderServiceTier(
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Secret patterns that must never reach the transcript. Each replacement keeps
// a short label so the model still knows a credential was there.
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9-]{10,}\b/g },
	{ label: "api-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g },
	{ label: "github-token", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
	{ label: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ label: "slack-token", pattern: /\bxox[bpas]-[A-Za-z0-9-]{10,}\b/g },
	{ label: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ label: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
	{ label: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{ label: "bearer-token", pattern: /\bBearer [A-Za-z0-9._~+/-]{10,}={0,2}\b/g },
	{
		label: "credential-value",
		pattern: /((?:api[_-]?key|api[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*['"]?)([^\s'";,]{8,})/gi,
	},
];

export function scrubSecretsText(text: string): { changed: boolean; text: string } {
	let changed = false;
	let result = text;
	for (const { label, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		const next = result.replace(pattern, (_match, prefix?: string) =>
			typeof prefix === "string" ? `${prefix}[REDACTED ${label}]` : `[REDACTED ${label}]`,
		);
		if (next !== result) {
			changed = true;
			result = next;
		}
	}
	return { changed, text: result };
}

function scrubJsonValue(value: unknown): { changed: boolean; value: unknown } {
	if (typeof value === "string") {
		const { changed, text } = scrubSecretsText(value);
		return { changed, value: text };
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const scrubbed = scrubJsonValue(item);
			changed = changed || scrubbed.changed;
			return scrubbed.value;
		});
		return { changed, value: next };
	}
	if (value && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const scrubbed = scrubJsonValue(item);
			changed = changed || scrubbed.changed;
			next[key] = scrubbed.value;
		}
		return { changed, value: next };
	}
	return { changed: false, value };
}

type TextPart = { type: "text"; text: string };

// Tool results can echo credentials (tokens in URLs, keys in error text).
// Scrub them before they reach the transcript. Structured content is scrubbed
// alongside text: replacing content alone would drop it.
export function registerSecretScrubber(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (!Array.isArray(event.content) && event.structuredContent === undefined) return undefined;
		let changed = false;
		const content = (Array.isArray(event.content) ? event.content : []).map((part) => {
			if (part?.type !== "text" || typeof (part as TextPart).text !== "string") return part;
			const scrubbed = scrubSecretsText((part as TextPart).text);
			if (!scrubbed.changed) return part;
			changed = true;
			return { type: "text", text: scrubbed.text } as const;
		});
		let structuredContent = event.structuredContent;
		if (structuredContent !== undefined) {
			const scrubbed = scrubJsonValue(structuredContent);
			if (scrubbed.changed) {
				changed = true;
				structuredContent = scrubbed.value as typeof event.structuredContent;
			}
		}
		if (!changed) return undefined;
		return { content, structuredContent };
	});
}

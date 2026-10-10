import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createRequestPacer } from "./request-pacer.js";

type CodeSearchParams = {
	limit?: number;
	query: string;
};

const GREP_APP_BASE = "https://grep.app";
const GREP_APP_DOCS = "https://grep.app/search";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 25_000;
const SNIPPET_CHARS = 600;

// grep.app is a small free service with no documented quota; pace politely
// because Pi runs parallel tool calls in one process.
const grepAppPacer = createRequestPacer();

function withGrepAppPacing<T>(run: () => Promise<T>): Promise<T> {
	return grepAppPacer(1000, run);
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function cleanQuery(query: string): string {
	const clean = query.trim();
	if (!clean) throw new Error("Code search requires a non-empty query. Use grep.app syntax: keywords, regexp, lang:python, path:src/, repo:owner/name.");
	return clean;
}

function safeLimit(value: number | undefined): number {
	if (!Number.isFinite(value) || value === undefined) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
}

function formatText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function stripMarkup(snippet: string): string {
	return snippet
		.replace(/<\/?mark[^>]*>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
	if (!value || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).trimEnd()}…`;
}

async function fetchJson(url: URL): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: {
				accept: "application/json",
				"user-agent": "hypatia-code-search/1.0 (https://github.com/TQuang122/hypatia)",
			},
			signal: controller.signal,
		});
		if (response.status === 429) {
			throw new Error("grep.app rate-limited this request (HTTP 429). Narrow the query with lang:, path:, or repo: filters and retry.");
		}
		if (!response.ok) {
			throw new Error(`grep.app request failed: ${response.status} ${response.statusText}. Narrow the query or search the repository directly.`);
		}
		return response.json();
	} finally {
		clearTimeout(timeout);
	}
}

function fileUrl(repo: string | undefined, branch: string | undefined, path: string | undefined): string | undefined {
	if (!repo || !path) return undefined;
	const cleanPath = path.replace(/^\/+/, "");
	return branch
		? `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`
		: `https://github.com/${repo}/tree/HEAD/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
}

function parseCodeHit(item: unknown): Record<string, unknown> | undefined {
	const record = recordValue(item);
	const repo = stringValue(recordValue(record.repo).raw) ?? stringValue(record.repo);
	const path = stringValue(recordValue(record.path).raw) ?? stringValue(record.path);
	if (!repo || !path) return undefined;
	const rawSnippet = stringValue(recordValue(record.content).snippet) ?? stringValue(record.snippet);
	const branch = stringValue(recordValue(record.branch).raw) ?? stringValue(record.branch);
	return {
		repo,
		path,
		branch,
		snippet: truncateText(rawSnippet ? stripMarkup(rawSnippet) : undefined, SNIPPET_CHARS),
		url: fileUrl(repo, branch, path),
	};
}

export async function searchCode(params: CodeSearchParams): Promise<Record<string, unknown>> {
	const query = cleanQuery(params.query);
	const limit = safeLimit(params.limit);
	const url = new URL(`${GREP_APP_BASE}/api/search`);
	url.search = new URLSearchParams({ q: query }).toString();
	const payload = recordValue(await withGrepAppPacing(() => fetchJson(url)));
	const hits = recordValue(payload.hits);
	const results = arrayValue(hits.hits).flatMap((item) => {
		const row = parseCodeHit(item);
		return row ? [row] : [];
	}).slice(0, limit);
	return {
		schema: "hypatia.codeSearch.v1",
		source: "grep_app",
		query,
		totalCount: numberValue(recordValue(hits.total).value) ?? results.length,
		returned: results.length,
		results,
		provenance: {
			docs: GREP_APP_DOCS,
			endpoints: [url.toString()],
		},
	};
}

export function registerCodeSearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hypatia_code_search",
		label: "Code Search",
		description:
			"Search public GitHub code through grep.app: keywords, regular expressions, and lang:, path:, repo: filters. Returns repository, file path, code snippet, and file URLs with endpoint provenance. Best for finding implementations, usages, and prior art behind paper claims.",
		promptSnippet: "Search public GitHub code with grep.app for implementations, usages, and prior art.",
		promptGuidelines: [
			"Use hypatia_code_search for paper-code audits and replication: find the implementation a paper describes, check how an API is actually used, or locate prior art. Narrow broad queries with lang:, path:, or repo: filters.",
			"Snippets are retrieval evidence; read the full file before claiming what the code does.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Code search query in grep.app syntax. Examples: httpx Client, lang:python dataclass, path:src/ transformer, repo:pytorch/pytorch autograd.",
			}),
			limit: Type.Optional(Type.Number({ description: `Maximum records to return. Defaults to ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` })),
		}),
		async execute(_toolCallId, params) {
			const result = await searchCode(params as CodeSearchParams);
			return {
				content: [{ type: "text", text: formatText(result) }],
				details: result,
			};
		},
	});
}

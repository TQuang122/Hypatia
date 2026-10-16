import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { formatToolDuration } from "../extensions/research-tools/render-utils.js";
import { createPaperReadRenderers } from "../extensions/research-tools/paper-read-renderer.js";
import { createPaperSearchRenderers } from "../extensions/research-tools/paper-search-renderer.js";
import { registerScienceDatabaseTools } from "../extensions/research-tools/science-databases.js";
import { registerAlphaTools } from "../extensions/research-tools/alpha.js";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const theme = { fg: (_key: string, text: string) => `\x1b[38;2;147;197;253m${text}\x1b[0m` } as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const collapsed = { expanded: false, isPartial: false };

function context(source = "openalex", durationMs?: number, args: Record<string, unknown> = { source }): RenderContext {
	return { args, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false, durationMs, outputPad: 0 };
}

function result(details: unknown): AgentToolResult<unknown> {
	return { details, content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
}

test("search summaries include the recorded duration and preserve expanded content", () => {
	const renderers = createPaperSearchRenderers("database");
	const data = result({ source: "openalex", returned: 2, totalCount: 20_000, results: [{ title: "First" }, { title: "Second" }] });
	const snapshot = JSON.stringify(data);
	const ctx = context("openalex", 1_400);
	const compact = renderers.renderResult(data, collapsed, theme, ctx);
	assert.equal(plain(compact.render(100)), "Complete · OpenAlex · 2 results · 1.4s");
	const expanded = renderers.renderResult(data, { ...collapsed, expanded: true }, theme, ctx);
	const expandedText = plain(expanded.render(1_000)).split("\n").map((line) => line.trimEnd()).join("\n");
	assert.equal(expandedText, data.content[0].type === "text" ? data.content[0].text : "");
	assert.equal(JSON.stringify(data), snapshot);
});

test("tool duration formatting handles subsecond, second, minute, and unavailable values", () => {
	assert.equal(formatToolDuration(undefined), undefined);
	assert.equal(formatToolDuration(Number.NaN), undefined);
	assert.equal(formatToolDuration(-1), undefined);
	assert.equal(formatToolDuration(999), "999ms");
	assert.equal(formatToolDuration(999.9), "1.0s");
	assert.equal(formatToolDuration(1_400), "1.4s");
	assert.equal(formatToolDuration(61_200), "1m 1s");
});

test("paper-read summaries show the recorded duration", () => {
	const rendered = createPaperReadRenderers().renderResult(
		result({ paperId: "2401.12345", source: "arxiv" }),
		collapsed,
		theme,
		context("arxiv", 1_400, { paper: "2401.12345" }),
	);
	assert.equal(plain([rendered.render(160)[0] ?? ""]), "Paper read · arXiv:2401.12345 · AI report · 1.4s");
});

test("fallback summaries display delivered source and reason instead of labeling results as the requested source", () => {
	const data = result({ source: "openalex", returned: 1, results: [{}], fallbackNote: "Semantic Scholar was unavailable (429); these results are from OpenAlex." });
	const rows = createPaperSearchRenderers("database").renderResult(data, collapsed, theme, context("semanticscholar")).render(100);
	assert.equal(plain([rows[0]]), "Fallback · OpenAlex · 1 result");
	assert.match(plain([rows[1]]), /Semantic Scholar.*429.*OpenAlex/);
	assert.match(plain(createPaperSearchRenderers("alpha").renderResult(data, collapsed, theme, context()).render(100)), /Fallback · OpenAlex/);
});

test("alphaXiv multi-mode results keep group counts without double-counting overlapping papers", () => {
	const data = result({ mode: "all", semantic: { results: [{ title: "Same" }] }, keyword: { results: [{ title: "Same" }] }, agentic: { results: [{ title: "Other" }] } });
	const text = plain(createPaperSearchRenderers("alpha").renderResult(data, collapsed, theme, context()).render(150));
	assert.match(text, /alphaXiv.*semantic 1 \/ keyword 1 \/ agentic 1/);
	assert.equal(text.includes("3 results"), false);
});

test("partial results and unknown counts never look like completed zero-result searches", () => {
	const renderers = createPaperSearchRenderers("database");
	const ctx = context();
	const partial = renderers.renderResult({ content: [], details: undefined }, { ...collapsed, isPartial: true }, theme, ctx);
	assert.match(plain(partial.render(120)), /Searching.*OpenAlex \(requested\).*awaiting results/);
	assert.equal(plain(partial.render(120)).includes("0 results"), false);
	ctx.lastComponent = partial;
	const done = renderers.renderResult(result({ source: "openalex", results: [] }), collapsed, theme, ctx);
	assert.equal(done, partial);
	assert.equal(plain(done.render(120)), "Complete · OpenAlex · 0 results");
});

test("search errors and metadata-only notes remain visible in collapsed output", () => {
	const renderers = createPaperSearchRenderers("database");
	const ctx = context("core");
	ctx.isError = true;
	const failed = { content: [{ type: "text" as const, text: "CORE request failed: 429 Too Many Requests\nTry later." }], details: undefined };
	const error = plain(renderers.renderResult(failed, collapsed, theme, ctx).render(100));
	assert.match(error, /^Error · CORE \(requested\)/);
	assert.match(error, /429 Too Many Requests/);
	const note = plain(renderers.renderResult(result({ source: "core", results: [{}], note: "Metadata-only; full text unavailable." }), collapsed, theme, context("core")).render(100));
	assert.match(note, /^Note · CORE · 1 result/);
	assert.match(note, /Metadata-only/);
});

test("Kev advisory is explicit, visible, and leaves the source order in place", () => {
	const renderers = createPaperSearchRenderers("kev");
	const advisoryData = result({
		source: "openalex",
		results: [
			{ title: "Original first", kevScore: 0.2, kevOriginalRank: 1 },
			{ title: "Suggested first", kevScore: 0.9, kevOriginalRank: 2 },
		],
		kevSuggestedOrder: [
			{ candidateId: "suggested", title: "Suggested first", kevScore: 0.9, kevOriginalRank: 2 },
			{ candidateId: "original", title: "Original first", kevScore: 0.2, kevOriginalRank: 1 },
		],
		kevStatus: { state: "advisory", message: "Kev suggested an order; source order was preserved." },
	});
	const call = plain(renderers.renderCall({ source: "openalex", query: "query" }, theme, context("openalex")).render(120));
	assert.match(call, /Kev advisory · OpenAlex/u);
	const advisory = plain(renderers.renderResult(
		advisoryData,
		collapsed,
		theme,
		context("openalex"),
	).render(140));
	assert.match(advisory, /Complete · OpenAlex · 2 results/u);
	assert.match(advisory, /Kev suggested an order; source order was preserved/u);
	const expanded = plain(renderers.renderResult(advisoryData, { ...collapsed, expanded: true }, theme, context("openalex")).render(1_000));
	assert.match(expanded, /kevSuggestedOrder/u);
	assert.ok(expanded.indexOf("Original first") < expanded.indexOf("Suggested first"));

	const databaseRenderer = createPaperSearchRenderers("database");
	const fallback = plain(databaseRenderer.renderResult(
		result({
			source: "openalex",
			results: [{ title: "Paper" }],
			kevStatus: { state: "unavailable", message: "Kev was unavailable (HTTP 503); original order was retained." },
		}),
		collapsed,
		theme,
		context("openalex"),
	).render(140));
	assert.match(fallback, /Kev was unavailable.*original order was retained/u);
});

test("search rendering fits narrow widths and neutralizes control characters in summary fields", () => {
	const renderers = createPaperSearchRenderers("database");
	const data = result({ source: "日本語\nsource\x1b]evil\x07", results: [{}], note: "note\nnext\x00" });
	for (const width of [1, 8, 20, 80]) {
		const rows = renderers.renderResult(data, collapsed, theme, context()).render(width);
		const call = renderers.renderCall({ source: "pubmed", query: "query\nnext\x1b]evil\x07" }, theme, context()).render(width);
		for (const row of [...rows, ...call]) {
			assert.ok(visibleWidth(row) <= width);
			assert.equal(plain([row]).includes("\x1b"), false);
			assert.equal(plain([row]).includes("\x00"), false);
		}
	}
});

test("both registered search tools expose renderers and rendering does not repeat retrieval or mutate tool results", async (t) => {
	const tools = new Map<string, ToolDefinition>();
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: () => () => {} } as unknown as ExtensionAPI;
	registerScienceDatabaseTools(pi);
	registerAlphaTools(pi, true);
	assert.equal(typeof tools.get("alpha_search")?.renderCall, "function");
	assert.equal(typeof tools.get("alpha_search")?.renderResult, "function");
	const search = tools.get("hypatia_science_database_search")!;
	const savedFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = savedFetch; });
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return Response.json({ message: { "total-results": 10_000, items: [{ DOI: "10.1000/example", title: ["Example"], author: [] }] } });
	};
	const data = await search.execute("call-1", { source: "crossref", query: "example" }, undefined, undefined, {} as never);
	const snapshot = JSON.stringify(data);
	const ctx = context("crossref");
	assert.match(plain(search.renderResult!(data, collapsed, theme, ctx).render(100)), /Crossref · 1 result/);
	search.renderResult!(data, { ...collapsed, expanded: true }, theme, ctx).render(100);
	assert.equal(JSON.stringify(data), snapshot);
	assert.equal(requests, 1);
});

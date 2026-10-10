import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createCodeSearchRenderers } from "../extensions/research-tools/code-search.js";
import { createHuggingFaceRenderers } from "../extensions/research-tools/huggingface-renderer.js";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const theme = {
	fg: (_color: string, text: string) => `\x1b[38;2;147;197;253m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/gu, "");
const collapsed: ToolRenderResultOptions = { expanded: false, isPartial: false };

function context(args: Record<string, unknown>, isError = false, durationMs = 1_400): RenderContext {
	return {
		args, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
		executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
		isError, durationMs, outputPad: 0,
	};
}

function result(details: unknown): AgentToolResult<unknown> {
	return { details, content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
}

test("code search renders a compact source card and keeps the original result expandable", () => {
	const renderers = createCodeSearchRenderers();
	const data = result({
		totalCount: 12,
		returned: 2,
		results: [{ repo: "org/project", path: "src/client.ts", snippet: "const client = new Client();" }, { repo: "org/other", path: "src/other.ts" }],
	});
	const snapshot = JSON.stringify(data);
	const compactText = plain(renderers.renderResult(data, collapsed, theme, context({ query: "Client" })).render(100));
	assert.match(compactText, /Code search · 12 matches · 2 shown · 1\.4s/);
	assert.match(compactText, /org\/project · src\/client\.ts/);
	assert.match(compactText, /const client = new Client\(\);/);
	const expanded = renderers.renderResult(data, { ...collapsed, expanded: true }, theme, context({ query: "Client" }));
	assert.equal(plain(expanded.render(2_000)).split("\n").map((line) => line.trimEnd()).join("\n"), data.content[0]?.type === "text" ? data.content[0].text : "");
	assert.equal(JSON.stringify(data), snapshot);
});

test("code search no-hit and error cards still point to the expanded output", () => {
	const renderers = createCodeSearchRenderers();
	const noHits = plain(renderers.renderResult(result({ totalCount: 0, returned: 0, results: [] }), collapsed, theme, context({ query: "unknown" })).render(100));
	assert.match(noHits, /No matches/);
	assert.match(noHits, /Ctrl\+O for full search details/);
	const failedContext = context({ query: "unknown" }, true);
	const error = { content: [{ type: "text" as const, text: "grep.app rate-limited this request" }], details: undefined };
	const errorText = plain(renderers.renderResult(error, collapsed, theme, failedContext).render(100));
	assert.match(errorText, /Error · Code search/);
	assert.match(errorText, /Ctrl\+O for full error details/);
});

test("Hugging Face dataset cards show schema, splits and access flags", () => {
	const renderer = createHuggingFaceRenderers("dataset-info");
	const data = result({
		id: "org/dataset", gated: true, private: true, downloads: 1_250,
		datasetInfo: { features: { text: { dtype: "string" }, label: { dtype: "int64" } }, splits: [{ name: "train" }, { name: "test" }] },
	});
	const summary = plain(renderer.renderResult(data, collapsed, theme, context({ dataset: "org/dataset" })).render(100));
	assert.match(summary, /HF dataset · org\/dataset · 2 features · 2 splits/);
	assert.match(summary, /private · gated/);
	assert.match(summary, /train, test/);
	assert.match(summary, /1,250 downloads/);
});

test("Hugging Face file cards identify truncated lists and read content", () => {
	const files = result({
		repo: "org/model", repoType: "model", revision: "abc123", count: 5, truncated: true,
		files: [{ path: "README.md" }, { path: "config.json" }],
	});
	const filesText = plain(createHuggingFaceRenderers("repo-files").renderResult(files, collapsed, theme, context({ repo: "org/model" })).render(100));
	assert.match(filesText, /HF model files · org\/model · 2 of 5/);
	assert.match(filesText, /README\.md/);
	assert.match(filesText, /Ctrl\+O for full file list/);

	const read = result({ repo: "org/model", path: "README.md", revision: "main", sizeChars: 20_000, truncated: true, content: "# Model card\nfull text" });
	const readRenderer = createHuggingFaceRenderers("read-file");
	const readText = plain(readRenderer.renderResult(read, collapsed, theme, context({ repo: "org/model", path: "README.md" })).render(100));
	assert.match(readText, /HF file · org\/model\/README\.md · 20,000 chars/);
	assert.match(readText, /# Model card/);
	const expanded = readRenderer.renderResult(read, { ...collapsed, expanded: true }, theme, context({ repo: "org/model", path: "README.md" }));
	assert.equal(plain(expanded.render(2_000)).split("\n").map((line) => line.trimEnd()).join("\n"), read.content[0]?.type === "text" ? read.content[0].text : "");
});

test("compact research-tool rows stay within narrow terminal widths", () => {
	const rows = createHuggingFaceRenderers("repo-files").renderResult(
		result({ repo: "org/model", count: 1, files: [{ path: "some/very/long/path/to/a/file.md" }] }),
		collapsed,
		theme,
		context({ repo: "org/model" }),
	);
	for (const width of [1, 8, 20, 60]) {
		for (const line of rows.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

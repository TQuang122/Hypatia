import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { extractCitationSources, runSourcesCommand } from "../extensions/research-tools/citation-sources.js";
import { CitationSourcesPanel } from "../extensions/research-tools/citation-sources-panel.js";

test("source extraction keeps titles, DOI/arXiv identifiers, and only explicit verification", () => {
	assert.deepEqual(extractCitationSources([
		"[Scaling laws](https://example.org/paper) — Verification status: verified",
		"DOI: 10.1234/example.2",
		"arXiv: 2401.12345v2",
	].join("\n")), [
		{ title: "Scaling laws", url: "https://example.org/paper", verification: "verified" },
		{ title: "DOI:10.1234/example.2", url: "https://doi.org/10.1234/example.2", identifier: "DOI:10.1234/example.2" },
		{ title: "arXiv:2401.12345v2", url: "https://arxiv.org/abs/2401.12345v2", identifier: "arXiv:2401.12345v2" },
	]);
});

test("sources panel filters, opens and copies the selected citation within the terminal width", async () => {
	const opened: string[] = [], copied: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		style: (text: string) => text,
		colors: { selectedBg: "", customMessageBg: "" },
	} as any;
	const panel = new CitationSourcesPanel({ terminal: { rows: 28 }, requestRender() {} }, {
		sources: [
			{ title: "Scaling laws", url: "https://example.org/scaling", verification: "verified" },
			{ title: "Attention paper", url: "https://arxiv.org/abs/2401.12345", identifier: "arXiv:2401.12345" },
		],
		theme: () => theme,
		copyUrl: async (url) => { copied.push(url); },
		openUrl: (url) => { opened.push(url); },
		done() {},
	});
	const lines = panel.render(64);
	assert.ok(lines.join("\n").includes("Verification  verified"));
	assert.ok(lines.every((line) => visibleWidth(line) <= 64));
	panel.handleInput("\u001b[B");
	panel.handleInput("\r");
	panel.handleInput("c");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(opened, ["https://arxiv.org/abs/2401.12345"]);
	assert.deepEqual(copied, ["https://arxiv.org/abs/2401.12345"]);
});

test("sources panel filter narrows the list without assigning an unstated verification status", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: { selectedBg: "", customMessageBg: "" } } as any;
	const panel = new CitationSourcesPanel({ terminal: { rows: 28 }, requestRender() {} }, {
		sources: [
			{ title: "Scaling laws", url: "https://example.org/scaling" },
			{ title: "Attention paper", url: "https://arxiv.org/abs/2401.12345", identifier: "arXiv:2401.12345" },
		],
		theme: () => theme, copyUrl: async () => {}, openUrl: () => {}, done() {},
	});
	panel.focused = true;
	panel.handleInput("/");
	for (const key of "arxiv") panel.handleInput(key);
	panel.handleInput("\r");
	const output = panel.render(64).join("\n");
	assert.match(output, /Attention paper/u);
	assert.doesNotMatch(output, /Scaling laws/u);
	assert.match(output, /Verification  not stated in the answer/u);
});

test("/sources opens one panel above the composer instead of nested selectors", async () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: { selectedBg: "", customMessageBg: "" } } as any;
	let panel: unknown, overlayOptions: unknown, selectorCalls = 0;
	await runSourcesCommand({
		mode: "tui", hasUI: true,
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "[Paper](https://example.org/paper)" }] } }] },
		ui: {
			theme,
			notify() {},
			select: async () => { selectorCalls++; return undefined; },
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => unknown, options: unknown) => {
				panel = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, undefined, () => {});
				overlayOptions = options;
			},
		},
	} as any);
	assert.ok(panel instanceof CitationSourcesPanel);
	assert.equal(selectorCalls, 0);
	assert.deepEqual(overlayOptions, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "96%", maxHeight: "78%", offsetY: -5, margin: 1 } });
});

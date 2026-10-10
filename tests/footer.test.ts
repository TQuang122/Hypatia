import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, ExtensionUIContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installHypatiaFooter } from "../extensions/research-tools/footer.js";

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function fixture() {
	const statuses = new Map<string, string>();
	const colors: Array<{ color: string; text: string }> = [];
	const theme = { fg: (color: string, text: string) => {
		colors.push({ color, text });
		return `\x1b[38;2;147;197;253m${text}\x1b[0m`;
	} } as Theme;
	const state = {
		entries: [] as unknown[], leaf: "leaf-1", session: "session-1", scans: 0,
		usage: { tokens: 50 as number | null, contextWindow: 200, percent: 25 as number | null },
		oauth: false, subscription: false, theme,
	};
	let factory: FooterFactory | undefined;
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/research/project",
		model: { provider: "openai", id: "gpt-example", reasoning: true }, thinkingLevel: "high",
		getContextUsage: () => state.usage,
		sessionManager: {
			getSessionId: () => state.session, getLeafId: () => state.leaf,
			getEntries: () => { state.scans += 1; return state.entries; },
			getBranch: () => { throw new Error("totals must include the whole session"); },
		},
		modelRegistry: {
			isUsingOAuth: () => state.oauth,
			getProvider: () => ({ auth: { oauth: { isSubscription: state.subscription } } }),
		},
		ui: { setFooter: (value: FooterFactory) => { factory = value; }, get theme() { return state.theme; } },
	};
	installHypatiaFooter(ctx as unknown as ExtensionContext);
	assert.ok(factory);
	const data = { getExtensionStatuses: () => statuses } as unknown as ReadonlyFooterDataProvider;
	const footer = factory({} as never, theme, data);
	return { ctx, state, statuses, colors, footer };
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

test("footer aggregates assistant, tool, cache-warm, compaction, and branch-summary usage without losing cached input", () => {
	const { state, footer } = fixture();
	state.entries = [
		{ type: "message", message: { role: "assistant", usage: usage(100, 20, 50, 5, .01) } },
		{ type: "message", message: { role: "toolResult", usage: usage(10, 2, 0, 0, .002) } },
		{ type: "usage", kind: "cache_warm", usage: usage(5, 0, 15, 0, .001) },
		{ type: "compaction", usage: usage(20, 3, 10, 0, .002) },
		{ type: "branch_summary", usage: usage(30, 4, 0, 5, .003) },
	];
	const rows = footer.render(120).map(plain);
	assert.equal(rows.length, 2);
	assert.match(rows[0], /openai\/gpt-example.*high.*ctx 25%.*↑250 ↓29.*R75 W10.*\$0.018/);
	assert.equal(rows[1], "/deepresearch · /lit · /review");
});

test("footer stays at two rows across narrow widths and model/thinking changes without rescanning unchanged entries", () => {
	const { ctx, state, footer } = fixture();
	state.entries = [{ type: "message", message: { role: "assistant", usage: usage(12345, 1234, 1000, 0, .012) } }];
	ctx.model.id = "很长的模型名称-gpt-research-long-model-name";
	for (const width of [1, 2, 8, 20, 40, 60, 80, 120]) {
		const rows = footer.render(width);
		assert.equal(rows.length, 2);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${plain(row)}`);
	}
	assert.equal(state.scans, 1);
	ctx.model.id = "new-model"; ctx.thinkingLevel = "low";
	assert.match(plain(footer.render(120)[0]), /new-model.*low/);
	state.usage.percent = null;
	assert.match(plain(footer.render(120)[0]), /ctx --/);
	assert.equal(state.scans, 1);
	state.leaf = "leaf-2";
	state.entries.push({ type: "usage", usage: usage(100, 20) });
	footer.render(120);
	assert.equal(state.scans, 2);
	state.session = "new-session"; state.entries = [];
	assert.match(plain(footer.render(120)[0]), /usage --/);
	assert.equal(state.scans, 3);
});

test("unknown or partial usage does not become invented zero-cost or token values", () => {
	const { state, footer } = fixture();
	let text = plain(footer.render(120)[0]);
	assert.match(text, /usage --.*cost --/);
	assert.equal(text.includes("$0.000"), false);
	state.entries = [{ type: "usage", usage: { input: 10 } }]; state.leaf = "partial";
	text = plain(footer.render(120)[0]);
	assert.match(text, /↑10 ↓--.*cost --/);
	state.entries.push({ type: "usage", usage: usage(20, 5, 0, 0, .02) }); state.leaf = "partial-2";
	assert.match(plain(footer.render(120)[0]), /↑30 ↓5\+.*\$0.020\+/);
	state.entries = [{ type: "usage", usage: usage(10, 5, 0, 0, .0002) }]; state.leaf = "tiny-cost";
	assert.match(plain(footer.render(120)[0]), /\$<0.001/);
});

test("subscription labels use provider metadata rather than assuming every OAuth login is a subscription", () => {
	const { state, footer } = fixture();
	state.oauth = true;
	assert.match(plain(footer.render(120)[0]), /cost --/);
	state.subscription = true;
	assert.match(plain(footer.render(120)[0]), / · sub$/);
	state.entries = [{ type: "usage", usage: usage(10, 5, 0, 0, .01) }]; state.leaf = "paid";
	assert.match(plain(footer.render(120)[0]), /\$0.010 \(sub\)/);
});

test("activity replaces shortcuts, preserves elapsed time when narrow, and prioritizes errors from other extensions", () => {
	const { statuses, footer } = fixture();
	statuses.set("hypatia-activity", "Searching sources · hypatia_science_database_search · 17s | agents 1 · evidence-scout");
	const narrow = plain(footer.render(40)[1]);
	assert.match(narrow, /^Searching.*17s$/);
	assert.equal(narrow.includes("/lit"), false);
	statuses.set("external", "Error · provider unavailable\nTry login\x1b]0;title\x07");
	const row = plain(footer.render(40)[1]);
	assert.match(row, /^Error · provider unavailable/);
	assert.equal(row.includes("title"), false);
	assert.ok(visibleWidth(row) <= 40);
	statuses.clear();
	assert.match(plain(footer.render(80)[1]), /\/lit/);
});

test("context warnings and changed themes are applied at render time", () => {
	const { state, colors, footer } = fixture();
	state.usage.percent = 95;
	footer.render(120);
	assert.ok(colors.some((call) => call.color === "error" && call.text === "ctx 95%"));
	state.theme = { fg: (_color: string, text: string) => `\x1b[38;2;10;20;30m${text}\x1b[0m` } as Theme;
	footer.invalidate();
	assert.ok(footer.render(80)[0].includes("38;2;10;20;30"));
});

test("RPC and print modes never install a terminal footer", () => {
	for (const mode of ["rpc", "print", "json"]) {
		installHypatiaFooter({ mode, hasUI: true, ui: { setFooter() { throw new Error("unexpected terminal UI"); } } } as unknown as ExtensionContext);
	}
});

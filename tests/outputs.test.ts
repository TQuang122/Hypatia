import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { canPreviewOutput, collectOutputArtifacts, MAX_OUTPUT_PREVIEW_BYTES, readOutputPreview, relatedOutput, type OutputPreview } from "../extensions/research-tools/output-artifacts.js";
import { OutputBrowserPanel } from "../extensions/research-tools/output-browser.js";
import { OutputReader, type OutputReaderTheme, type OutputReaderTUI } from "../extensions/research-tools/output-reader.js";
import { registerOutputsCommand, runOutputsCommand, type OutputsCommandContext } from "../extensions/research-tools/outputs.js";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const customMessageBg = rgbColor(18, 52, 86);
const searchMatchBg = rgbColor(101, 67, 33);
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	colors: { customMessageBg, searchMatchBg },
	style: (text, options) => {
		const background = options.bg === customMessageBg ? "\x1b[48;5;24m" : "\x1b[48;5;25m";
		return `${background}${text}\x1b[49m`;
	},
} satisfies OutputReaderTheme;
initTheme("dark", false);

function renderSignals() {
	const events = new EventEmitter();
	const waitForRenders = (count: number): Promise<void> => {
		const timeout = AbortSignal.timeout(1000);
		return new Promise((resolve, reject) => {
			let observed = 0;
			const cleanup = () => {
				events.removeListener("render", onRender);
				timeout.removeEventListener("abort", onTimeout);
			};
			const onRender = () => {
				if (++observed === count) { cleanup(); resolve(); }
			};
			const onTimeout = () => { cleanup(); reject(timeout.reason); };
			events.addListener("render", onRender);
			timeout.addEventListener("abort", onTimeout, { once: true });
			if (timeout.aborted) onTimeout();
		});
	};
	return { events, waitForRenders };
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hypatia-outputs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of ["outputs/.drafts", "outputs/.plans", "papers", "notes", "experiments"]) await mkdir(join(root, path), { recursive: true });
	return root;
}

test("outputs separate reports, provenance, drafts, and auxiliary files with newest-first sorting", async (t) => {
	const root = await workspace(t);
	for (const [path, content] of [
		["outputs/old.md", "# Old report"], ["outputs/new.MD", "# New report"],
		["outputs/new.provenance.md", "# Provenance: New\nVerification unknown"],
		["outputs/.drafts/new.md", "# Draft"], ["papers/topic-draft.md", "# Paper draft"],
		["notes/note.md", "# Note"], ["outputs/.plans/check.log", "diagnostic"], ["experiments/table.csv", "x,y\n1,2"],
	]) await writeFile(join(root, path), content);
	await utimes(join(root, "outputs/old.md"), 1, 1);
	await utimes(join(root, "outputs/new.MD"), 2, 2);
	const items = await collectOutputArtifacts(root);
	assert.deepEqual(items.filter((item) => item.group === "Reports").map((item) => item.path), [join("outputs", "new.MD"), join("outputs", "old.md")]);
	assert.equal(items.find((item) => item.path === join("outputs", "new.provenance.md"))?.group, "Provenance");
	assert.equal(items.filter((item) => item.group === "Drafts").length, 2);
	assert.equal(items.filter((item) => item.group === "Other artifacts").length, 3);
	const report = items.find((item) => item.path === join("outputs", "new.MD"))!;
	assert.equal(relatedOutput(report, items)?.path, join("outputs", "new.provenance.md"));
	assert.equal("verification" in report, false);
});

test("provenance pairing stays beside the selected report and never guesses across directories", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "outputs/topic.md"), "# Output");
	await writeFile(join(root, "papers/topic.provenance.md"), "# Provenance");
	let items = await collectOutputArtifacts(root);
	assert.equal(relatedOutput(items.find((item) => item.path === join("outputs", "topic.md"))!, items), undefined);
	await writeFile(join(root, "papers/topic.md"), "# Paper");
	items = await collectOutputArtifacts(root);
	assert.equal(relatedOutput(items.find((item) => item.path === join("papers", "topic.provenance.md"))!, items)?.path, join("papers", "topic.md"));
});

test("previews are bounded, neutralize terminal controls, and leave the original file unchanged", async (t) => {
	const root = await workspace(t);
	const source = "# Report\n\x1b]0;injected-title\x07\x1b[31mText\x1b[0m\n";
	await writeFile(join(root, "outputs/report.md"), source);
	await writeFile(join(root, "outputs/large.md"), "");
	await truncate(join(root, "outputs/large.md"), MAX_OUTPUT_PREVIEW_BYTES + 1);
	await writeFile(join(root, "outputs/huge.pdf"), "%PDF");
	await truncate(join(root, "outputs/huge.pdf"), 128 * 1024 * 1024);
	const items = await collectOutputArtifacts(root);
	const preview = await readOutputPreview(root, items.find((item) => item.path === join("outputs", "report.md"))!);
	assert.equal(preview.content.includes("\x1b"), false);
	assert.equal(preview.content.includes("injected-title"), false);
	assert.equal(await readFile(join(root, "outputs/report.md"), "utf8"), source);
	const excerpt = await readOutputPreview(root, items.find((item) => item.path === join("outputs", "report.md"))!, { maxBytes: 4, truncate: true });
	assert.equal(excerpt.content, "# Re");
	assert.equal(excerpt.truncated, true);
	await assert.rejects(readOutputPreview(root, items.find((item) => item.path === join("outputs", "large.md"))!), /2 MiB/);
	const pdf = items.find((item) => item.path === join("outputs", "huge.pdf"))!;
	assert.equal(pdf.size, 128 * 1024 * 1024);
	assert.equal(canPreviewOutput(pdf), false);
	await assert.rejects(readOutputPreview(root, pdf), /no text preview/);
});

test("artifact browsing skips symlinks and a stale preview cannot escape the workspace", async (t) => {
	const root = await workspace(t);
	const outside = await mkdtemp(join(tmpdir(), "hypatia-outputs-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(root, "outputs/report.md"), "# Report");
	await writeFile(join(outside, "external.md"), "outside");
	try { await symlink(join(outside, "external.md"), join(root, "outputs/link.md")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32") { t.skip("Windows symlink privilege unavailable"); return; }
		throw error;
	}
	const items = await collectOutputArtifacts(root);
	assert.equal(items.some((item) => item.path.endsWith("link.md")), false);
	const artifact = items.find((item) => item.path === join("outputs", "report.md"))!;
	await assert.rejects(readOutputPreview(root, { ...artifact, fullPath: join(outside, "external.md") }), /outside/);
});

test("outputs opens a grouped artifact browser with a report preview", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "outputs/topic.md"), "# Topic report\nReport body preview.");
	await writeFile(join(root, "outputs/topic.provenance.md"), "# Provenance\nVerified source record.");
	let selectCalls = 0;
	let rendered = "";
	let customOptions: unknown;
	const ctx = {
		mode: "tui", hasUI: true, cwd: root,
		ui: {
			theme,
			select: async () => { selectCalls += 1; return undefined; },
			notify() {},
			setEditorText() {},
			custom: async <T>(factory: (...args: any[]) => any, options?: unknown): Promise<T> => {
				customOptions = options;
				let result: T | undefined;
				const panel = factory(
					{ terminal: { rows: 28, columns: 120 }, requestRender() {} },
					theme,
					{},
					(value: T) => { result = value; },
				);
				rendered = plain(panel.render(120).join("\n"));
				panel.handleInput("\x1b");
				return result as T;
			},
		},
	} as unknown as OutputsCommandContext;

	await runOutputsCommand(ctx);

	assert.equal(selectCalls, 0);
	assert.deepEqual(customOptions, { overlay: true, overlayOptions: { anchor: "center", width: "96%", maxHeight: "88%", margin: 1 } });
	assert.match(rendered, /Reports/u);
	assert.match(rendered, /Provenance/u);
	assert.match(rendered, /Topic report/u);
	assert.match(rendered, /Report body preview/u);
});

test("outputs browser filters, scrolls, pairs provenance, and stays within narrow and wide terminals", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "outputs/alpha.md"), "# Alpha report\nAlpha preview.");
	await writeFile(join(root, "outputs/alpha.provenance.md"), "# Alpha provenance\nSource record.");
	await writeFile(join(root, "outputs/beta.md"), "# Beta report\nBeta preview.");
	const items = await collectOutputArtifacts(root);
	const report = items.find((item) => item.path === join("outputs", "beta.md"))!;
	const initialPreview = await readOutputPreview(root, report, { maxBytes: 12 * 1024, truncate: true });
	const actions: any[] = [];
	const panel = new OutputBrowserPanel({ terminal: { rows: 28 }, requestRender() {} }, {
		items,
		state: { group: "Reports", selectedPath: report.path, query: "" },
		initialPreview,
		loadPreview: (artifact) => readOutputPreview(root, artifact, { maxBytes: 12 * 1024, truncate: true }),
		copyPath: async () => {},
		theme: () => theme,
		done: (action) => actions.push(action),
	});

	assert.match(plain(panel.render(120).join("\n")), /Beta report/u);
	const wheel: TuiMouseEvent = {
		type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0,
		width: 120, height: 28, shift: false, alt: false, ctrl: false, wheelDelta: 1,
	};
	assert.deepEqual(panel.handleMouse(wheel), { handled: true, render: true });
	assert.match(plain(panel.render(120).join("\n")), /› Alpha report/u);
	panel.handleInput("/");
	panel.handleInput("Alpha");
	panel.handleInput("\r");
	assert.match(plain(panel.render(120).join("\n")), /1\/2/u);
	panel.handleInput("p");
	assert.match(plain(panel.render(70).join("\n")), /Provenance/u);
	for (const width of [40, 70, 120]) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
	}
	panel.handleInput("\r");
	assert.equal(actions[0]?.type, "open");
	assert.equal(actions[0]?.artifact.path, join("outputs", "alpha.provenance.md"));
	assert.equal(actions[0]?.state.group, "Provenance");
	panel.dispose();
});

function reader(content: string, markdown = false, terminalRows = 24, copyPath?: () => Promise<void>) {
	let renders = 0, copies = 0;
	const actions: string[] = [];
	const signals = renderSignals();
	const tui: OutputReaderTUI = { terminal: { rows: terminalRows }, requestRender: () => { renders += 1; signals.events.emit("render"); } };
	const preview: OutputPreview = { markdown, content, artifact: { path: "outputs/report.md", fullPath: "/workspace/outputs/report.md", title: "Report", group: "Reports", extension: ".md", size: content.length, modifiedAt: 1 } };
	const view = new OutputReader(tui, { preview, relatedLabel: "provenance", theme: () => theme, copyPath: copyPath ?? (async () => { copies += 1; }), done: (action) => actions.push(action) });
	view.focused = true;
	return { view, actions, waitForRenders: signals.waitForRenders, get copies() { return copies; }, get renders() { return renders; } };
}

test("reader scrolls, searches matching rows, and keeps all rendered lines within the viewport", () => {
	const { view, actions } = reader(Array.from({ length: 70 }, (_, index) => `Row ${index} ${index === 25 || index === 55 ? "needle" : "body"}`).join("\n"));
	view.render(80);
	view.handleInput("\x1b[6~");
	assert.match(plain(view.render(80).join("\n")), /Row 20 body/);
	view.handleInput("/"); view.handleInput("needle"); view.handleInput("\r");
	assert.match(plain(view.render(80).join("\n")), /1\/2 matching rows/);
	assert.match(plain(view.render(80).join("\n")), /Row 25 needle/);
	view.handleInput("n");
	assert.match(plain(view.render(80).join("\n")), /2\/2 matching rows/);
	view.handleInput("N");
	assert.match(plain(view.render(80).join("\n")), /1\/2 matching rows/);
	for (const width of [20, 40, 80, 120]) {
		const rows = view.render(width);
		assert.equal(rows.length, 24);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${plain(row)}`);
	}
	view.handleInput("\x1b");
	assert.deepEqual(actions, ["back"]);
});

test("reader uses terminal height while reserving application chrome", () => {
	const sample = reader(Array.from({ length: 70 }, (_, index) => `Row ${index} body`).join("\n"), false, 48);
	const lines = sample.view.render(80);
	assert.equal(lines.length, 48);
	assert.ok(lines.every((line) => visibleWidth(line) === 80));
	assert.ok(lines.every((line) => /^\x1b\[48;5;2[45]m/u.test(line) && line.endsWith("\x1b[49m")));
	assert.ok(lines.some((line) => plain(line).includes("Row 43 body")));
	assert.ok(!lines.some((line) => plain(line).includes("Row 44 body")));
});

test("Markdown preview remains searchable and local actions never alter document content", async () => {
	const source = "# Scientific report\n\nA **distinctive result** and a [source](https://example.org).\n";
	const sample = reader(source, true);
	const text = plain(sample.view.render(80).join("\n"));
	assert.match(text, /Scientific report/);
	sample.view.handleInput("/"); sample.view.handleInput("distinctive"); sample.view.handleInput("\r");
	assert.match(plain(sample.view.render(80).join("\n")), /1\/1 matching rows/);
	const copyRendered = sample.waitForRenders(2);
	sample.view.handleInput("c");
	await copyRendered;
	assert.equal(sample.copies, 1);
	assert.match(plain(sample.view.render(80).join("\n")), /Path copied/);
	sample.view.handleInput("p");
	assert.deepEqual(sample.actions, ["related"]);
});

test("search cancellation, mouse scrolling, and clipboard failure keep the reader usable", async () => {
	const sample = reader(Array.from({ length: 60 }, (_, index) => `Row ${index} body`).join("\n"));
	sample.view.render(80);
	sample.view.handleInput("/"); sample.view.handleInput("absent"); sample.view.handleInput("\r");
	assert.match(plain(sample.view.render(80).join("\n")), /no matches/);
	sample.view.handleInput("/"); sample.view.handleInput("\x03");
	assert.deepEqual(sample.actions, []);
	const wheel: TuiMouseEvent = {
		type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24,
		shift: false, alt: false, ctrl: false, wheelDelta: 3,
	};
	sample.view.handleMouse(wheel);
	assert.match(plain(sample.view.render(80).join("\n")), /Row 3 body/);
	const failed = reader("text", false, 24, async () => { throw new Error("clipboard unavailable"); });
	const copyRendered = failed.waitForRenders(2);
	failed.view.handleInput("c");
	await copyRendered;
	assert.match(plain(failed.view.render(80).join("\n")), /Copy failed: clipboard unavailable/);
});

test("outputs browser opens report and provenance, copies a path, and preserves the composer", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "outputs/topic.md"), "# Report body\nA result.");
	await writeFile(join(root, "outputs/topic.provenance.md"), "# Provenance body\nRecorded source.");
	let commandName = "";
	const api = { registerCommand(name: string) { commandName = name; } } satisfies Pick<ExtensionAPI, "registerCommand">;
	const copied: string[] = [], views: string[] = [];
	const viewLines: string[][] = [];
	type CustomOptions = Parameters<OutputsCommandContext["ui"]["custom"]>[1];
	const customOptions: CustomOptions[] = [];
	registerOutputsCommand(api);
	assert.equal(commandName, "outputs");
	let selection = 0;
	let customCalls = 0;
	const ctx = {
		mode: "tui", hasUI: true, cwd: root,
		ui: {
			theme,
			select: async (_title: string, options: string[]) => selection++ < 2 ? options[0] : undefined,
			notify() {},
			setEditorText() { throw new Error("direct viewing must preserve the composer"); },
			custom: async <T>(
				factory: (tui: OutputReaderTUI, theme: OutputReaderTheme, keys: unknown, done: (action: T) => void) => OutputReader,
				options?: CustomOptions,
			): Promise<T> => {
				customOptions.push(options);
				customCalls += 1;
				let result: T | undefined;
				const signals = renderSignals();
				const tui: OutputReaderTUI = { terminal: { rows: 24 }, requestRender: () => signals.events.emit("render") };
				const view = factory(tui, theme, undefined, (value) => { result = value; });
				const rendered = view.render(80);
				views.push(plain(rendered.join("\n")));
				if (views.length > 1 && views.length < 4) viewLines.push(rendered);
				if (views.length === 1) view.handleInput(String.fromCharCode(13));
				else if (views.length === 2) view.handleInput("p");
				else if (views.length === 3) {
					const copyRendered = signals.waitForRenders(2);
					view.handleInput("c");
					await copyRendered;
					view.handleInput(String.fromCharCode(27));
				} else view.handleInput(String.fromCharCode(27));
				assert.ok(result);
				return result;
			},
		},
	} as unknown as OutputsCommandContext;
	await runOutputsCommand(ctx, async (path) => { copied.push(path); });
	assert.match(views[0], /Report body/);
	assert.match(views[1], /Report body/);
	assert.match(views[2], /Provenance body/);
	assert.equal(views.length, 4);
	assert.ok(viewLines.every((lines) => lines.length === 24));
	assert.ok(viewLines.every((lines) => lines.every((line) => visibleWidth(line) === 80)));
	assert.ok(viewLines.every((lines) => lines.every((line) => line.startsWith("\x1b[48;5;24m") && line.endsWith("\x1b[49m"))));
	assert.deepEqual(copied, [join(root, "outputs/topic.provenance.md")]);
	assert.deepEqual(customOptions.map((options) => options?.overlay), [true, true, true, true]);
	assert.deepEqual(customOptions.map((options) => options?.overlayOptions), [
		{ anchor: "center", width: "96%", maxHeight: "88%", margin: 1 },
		{ anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
		{ anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
		{ anchor: "center", width: "96%", maxHeight: "88%", margin: 1 },
	]);
});

test("unsupported files keep the chat fallback and RPC avoids interactive UI", async (t) => {
	const root = await workspace(t);
	const path = join("outputs", process.platform === "win32" ? "report with spaces.pdf" : 'report "with spaces".pdf');
	await writeFile(join(root, path), "%PDF");
	let prompt = "", warnings = 0, customCalls = 0;
	const ctx = {
		mode: "tui", hasUI: true, cwd: root,
		ui: {
			theme,
			setEditorText: (value: string) => { prompt = value; },
			notify: () => { warnings += 1; },
			custom: async <T>(factory: (...args: any[]) => any): Promise<T> => {
				customCalls += 1;
				let result: T | undefined;
				const panel = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, undefined, (value: T) => { result = value; });
				panel.handleInput("r");
				return result as T;
			},
		},
	} as unknown as OutputsCommandContext;
	await runOutputsCommand(ctx);
	assert.ok(prompt.includes(JSON.stringify(path)));
	await runOutputsCommand({ ...ctx, mode: "rpc" });
	assert.equal(warnings, 1);
	assert.equal(customCalls, 1);
});

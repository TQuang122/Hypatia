import { basename } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	Markdown,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	OUTPUT_GROUPS,
	canPreviewOutput,
	oneLine,
	relatedOutput,
	type OutputArtifact,
	type OutputGroup,
	type OutputPreview,
} from "./output-artifacts.js";

export type OutputBrowserState = { group: OutputGroup; selectedPath?: string; query: string };
export type OutputBrowserAction =
	| { type: "open"; artifact: OutputArtifact; state: OutputBrowserState }
	| { type: "read"; artifact: OutputArtifact }
	| { type: "close" };
export type OutputBrowserTUI = Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
export type OutputBrowserTheme = Pick<Theme, "bold" | "fg" | "style"> & {
	colors: Pick<Theme["colors"], "customMessageBg">;
};

type BrowserOptions = {
	items: readonly OutputArtifact[];
	state?: OutputBrowserState;
	initialPreview?: OutputPreview;
	initialPreviewError?: string;
	loadPreview: (artifact: OutputArtifact) => Promise<OutputPreview>;
	copyPath: (path: string) => Promise<void>;
	theme: () => OutputBrowserTheme;
	done: (action: OutputBrowserAction) => void;
};

const compactGroups: Record<OutputGroup, string> = {
	Reports: "Reports",
	Provenance: "Provenance",
	Drafts: "Drafts",
	"Other artifacts": "Other",
};

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export class OutputBrowserPanel implements Component, Focusable {
	private readonly groups: OutputGroup[];
	private groupIndex = 0;
	private selectedIndex = 0;
	private query = "";
	private editingSearch = false;
	private readonly search = new Input({ prompt: "/ ", placeholder: "Filter files by name or path" });
	private hasFocus = false;
	private listPageSize = 5;
	private preview?: OutputPreview;
	private previewError = "";
	private previewLoading = false;
	private previewDocument?: Markdown | Text;
	private previewWidth = -1;
	private previewLinesCache?: string[];
	private previewRequest = 0;
	private disposed = false;
	private copying = false;
	private notice = "";

	constructor(private readonly tui: OutputBrowserTUI, private readonly options: BrowserOptions) {
		this.groups = OUTPUT_GROUPS.filter((group) => options.items.some((item) => item.group === group));
		const defaultGroup = this.groups.includes("Reports") ? "Reports" : this.groups[0]!;
		this.groupIndex = Math.max(0, this.groups.indexOf(options.state?.group ?? defaultGroup));
		this.query = options.state?.query ?? "";
		this.search.setValue(this.query);
		const initialItems = this.currentItems();
		const initialIndex = options.state?.selectedPath
			? initialItems.findIndex((item) => item.path === options.state?.selectedPath)
			: 0;
		this.selectedIndex = Math.max(0, initialIndex);
		this.search.onSubmit = (value) => {
			this.query = oneLine(value);
			this.editingSearch = false;
			this.search.focused = false;
			this.selectedIndex = 0;
			this.notice = "";
			this.loadSelectedPreview();
			this.tui.requestRender();
		};
		this.search.onEscape = () => {
			this.editingSearch = false;
			this.search.focused = false;
			this.search.setValue(this.query);
			this.tui.requestRender();
		};

		const selected = this.selectedArtifact;
		if (selected && options.initialPreview?.artifact.path === selected.path) this.setPreview(options.initialPreview);
		else if (options.initialPreviewError) this.previewError = options.initialPreviewError;
		else if (selected && canPreviewOutput(selected)) this.loadSelectedPreview();
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) {
		this.hasFocus = value;
		this.search.focused = value && this.editingSearch;
	}

	dispose(): void {
		this.disposed = true;
		this.previewRequest += 1;
	}

	invalidate(): void {
		this.search.invalidate();
		this.previewWidth = -1;
		this.previewLinesCache = undefined;
		this.previewDocument = this.preview ? this.createPreviewDocument(this.preview) : undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		this.moveSelection(Math.trunc(event.wheelDelta));
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		if (this.editingSearch) {
			if (matchesKey(data, Key.ctrl("c"))) {
				this.editingSearch = false;
				this.search.focused = false;
				this.search.setValue(this.query);
			} else this.search.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.options.done({ type: "close" }); return; }
		if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
			this.editingSearch = true;
			this.search.setValue(this.query);
			this.search.focused = this.focused;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { this.changeGroup(1); return; }
		if (matchesKey(data, Key.left)) { this.changeGroup(-1); return; }
		if (matchesKey(data, Key.up)) { this.moveSelection(-1); return; }
		if (matchesKey(data, Key.down)) { this.moveSelection(1); return; }
		if (matchesKey(data, Key.pageUp)) { this.moveSelection(-this.listPageSize); return; }
		if (matchesKey(data, Key.pageDown)) { this.moveSelection(this.listPageSize); return; }
		if (matchesKey(data, Key.home)) { this.setSelection(0); return; }
		if (matchesKey(data, Key.end)) { this.setSelection(this.currentItems().length - 1); return; }
		if (matchesKey(data, Key.enter)) { this.openSelected(); return; }
		if (data === "p" || data === "P") { this.openRelated(); return; }
		if (data === "c" || data === "C") { void this.copySelectedPath(); return; }
		if (data === "r" || data === "R") { this.readSelectedInChat(); return; }
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const height = this.frameHeight();
		if (height < 14) return this.renderCompact(width, height);
		if (width >= 104 && height >= 18) return this.renderWide(width, height);
		return this.renderStacked(width, height);
	}

	private frameHeight(): number {
		const rows = Math.max(8, this.tui.terminal.rows);
		return Math.max(8, Math.min(rows - 2, Math.floor(rows * 0.86)));
	}

	private currentGroup(): OutputGroup { return this.groups[this.groupIndex] ?? "Other artifacts"; }
	private currentItems(): OutputArtifact[] { return this.options.items.filter((item) => item.group === this.currentGroup() && this.matchesQuery(item)); }
	private get selectedArtifact(): OutputArtifact | undefined { return this.currentItems()[this.selectedIndex]; }

	private matchesQuery(item: OutputArtifact): boolean {
		if (!this.query) return true;
		const query = this.query.toLocaleLowerCase();
		return `${item.path} ${item.title}`.toLocaleLowerCase().includes(query);
	}

	private state(): OutputBrowserState {
		return { group: this.currentGroup(), selectedPath: this.selectedArtifact?.path, query: this.query };
	}

	private setSelection(index: number): void {
		const items = this.currentItems();
		const next = items.length ? Math.max(0, Math.min(items.length - 1, index)) : 0;
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.notice = "";
		this.loadSelectedPreview();
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (!delta) return;
		this.setSelection(this.selectedIndex + delta);
	}

	private changeGroup(delta: number): void {
		if (this.groups.length < 2) return;
		this.groupIndex = (this.groupIndex + delta + this.groups.length) % this.groups.length;
		this.selectedIndex = 0;
		this.notice = "";
		this.loadSelectedPreview();
		this.tui.requestRender();
	}

	private loadSelectedPreview(): void {
		const artifact = this.selectedArtifact;
		const request = ++this.previewRequest;
		this.preview = undefined;
		this.previewDocument = undefined;
		this.previewWidth = -1;
		this.previewLinesCache = undefined;
		this.previewError = "";
		this.previewLoading = Boolean(artifact && canPreviewOutput(artifact));
		if (!artifact || !canPreviewOutput(artifact)) {
			this.previewLoading = false;
			return;
		}
		this.tui.requestRender();
		void this.options.loadPreview(artifact).then((preview) => {
			if (this.disposed || request !== this.previewRequest) return;
			this.setPreview(preview);
		}).catch((error: unknown) => {
			if (this.disposed || request !== this.previewRequest) return;
			this.previewLoading = false;
			this.previewError = oneLine(error instanceof Error ? error.message : String(error));
			this.tui.requestRender();
		});
	}

	private setPreview(preview: OutputPreview): void {
		this.preview = preview;
		this.previewLoading = false;
		this.previewError = "";
		this.previewDocument = this.createPreviewDocument(preview);
		this.previewWidth = -1;
		this.previewLinesCache = undefined;
		this.tui.requestRender();
	}

	private createPreviewDocument(preview: OutputPreview): Markdown | Text {
		return preview.markdown ? new Markdown(preview.content, 0, 0, getMarkdownTheme()) : new Text(preview.content, 0, 0);
	}

	private openSelected(): void {
		const artifact = this.selectedArtifact;
		if (!artifact) return;
		if (!canPreviewOutput(artifact)) {
			this.notice = `${artifact.extension.toUpperCase()} has no text preview · C copies path · R reads in chat`;
			this.tui.requestRender();
			return;
		}
		this.options.done({ type: "open", artifact, state: this.state() });
	}

	private openRelated(): void {
		const artifact = this.selectedArtifact;
		const related = artifact ? relatedOutput(artifact, this.options.items) : undefined;
		if (!related) {
			this.notice = "No matching report or provenance file.";
			this.tui.requestRender();
			return;
		}
		const groupIndex = this.groups.indexOf(related.group);
		if (groupIndex < 0) return;
		this.groupIndex = groupIndex;
		this.query = "";
		this.search.setValue("");
		this.selectedIndex = Math.max(0, this.currentItems().findIndex((item) => item.path === related.path));
		this.notice = `Showing linked ${related.group.toLocaleLowerCase()}`;
		this.loadSelectedPreview();
		this.tui.requestRender();
	}

	private async copySelectedPath(): Promise<void> {
		const artifact = this.selectedArtifact;
		if (!artifact || this.copying) return;
		this.copying = true;
		this.notice = "Copying path…";
		this.tui.requestRender();
		try {
			await this.options.copyPath(artifact.fullPath);
			this.notice = "Path copied";
		} catch (error) {
			this.notice = `Copy failed: ${oneLine(error instanceof Error ? error.message : String(error))}`;
		} finally {
			this.copying = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private readSelectedInChat(): void {
		const artifact = this.selectedArtifact;
		if (artifact) this.options.done({ type: "read", artifact });
	}

	private frameLine(content: string, width: number, selected = false): string {
		const theme = this.options.theme();
		const innerWidth = Math.max(0, width - 2);
		const text = truncateToWidth(content, innerWidth, innerWidth > 1 ? "…" : "");
		const body = text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
		const background = selected ? "selectedBg" : theme.colors.customMessageBg;
		return `${theme.fg("borderMuted", "│")}${theme.style(body, { bg: background })}${theme.fg("borderMuted", "│")}`;
	}

	private divider(width: number): string {
		return this.options.theme().fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
	}

	private top(width: number): string {
		return this.options.theme().fg("borderMuted", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
	}

	private bottom(width: number): string {
		return this.options.theme().fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private titleLine(): string {
		const theme = this.options.theme();
		return ` ${theme.fg("toolTitle", theme.bold("Research outputs"))}  ${theme.fg("muted", `${this.options.items.length} files · newest first`)} `;
	}

	private groupLine(): string {
		const theme = this.options.theme();
		return ` ${this.groups.map((group, index) => {
			const count = this.options.items.filter((item) => item.group === group).length;
			const label = `${compactGroups[group]} ${count}`;
			return index === this.groupIndex
				? theme.fg("accent", theme.bold(`[${label}]`))
				: theme.fg("muted", label);
		}).join("   ")} `;
	}

	private searchLine(width: number): string {
		const theme = this.options.theme();
		if (this.editingSearch) return ` ${this.search.render(Math.max(1, width - 2))[0] ?? ""} `;
		const label = this.query ? this.query : "filter artifacts by name or path";
		return ` ${theme.fg("accent", "/")} ${theme.fg("muted", label)}  ${theme.fg("dim", `${this.currentItems().length} matches`)} `;
	}

	private listHeading(): string {
		const items = this.currentItems();
		const total = this.options.items.filter((item) => item.group === this.currentGroup()).length;
		const start = items.length ? Math.min(this.selectedIndex + 1, items.length) : 0;
		return ` FILES · ${this.currentGroup()} · ${items.length === total ? total : `${items.length}/${total}`}  ${items.length ? `${start}/${items.length}` : ""} `;
	}

	private previewHeading(): string {
		const selected = this.selectedArtifact;
		const name = selected ? oneLine(selected.title || basename(selected.path)) : "Select a file";
		return ` PREVIEW · ${name} `;
	}

	private fileLabel(artifact: OutputArtifact, selected: boolean): string {
		const theme = this.options.theme();
		const name = oneLine(artifact.title || basename(artifact.path));
		const path = artifact.title ? theme.fg("muted", ` · ${oneLine(artifact.path)}`) : "";
		return `${theme.fg(selected ? "accent" : "text", `${selected ? "›" : " "} ${name}`)}${path}`;
	}

	private statusLine(): string {
		if (this.notice) return ` ${this.options.theme().fg("muted", this.notice)} `;
		const selected = this.selectedArtifact;
		if (!selected) return ` ${this.options.theme().fg("dim", "No matching files · / to change the filter")} `;
		const related = relatedOutput(selected, this.options.items);
		const pair = related ? ` · linked ${related.group.toLocaleLowerCase()}` : "";
		return ` ${selected.path} · ${selected.extension.slice(1).toUpperCase()} · ${formatSize(selected.size)} · ${formatDate(selected.modifiedAt)}${pair} `;
	}

	private helpLine(width: number): string {
		const help = width < 76
			? "↑↓/wheel · ←→ group · Enter preview · P pair · C path · R chat · Esc"
			: "↑↓/wheel files · ←→/Tab group · Enter preview · P pair · C path · R chat · / find · Esc close";
		return ` ${this.options.theme().fg("dim", help)} `;
	}

	private previewLines(width: number, count: number): string[] {
		if (count <= 0) return [];
		const theme = this.options.theme();
		const selected = this.selectedArtifact;
		if (!selected) return [theme.fg("dim", "Choose a matching file to preview.")];
		if (!canPreviewOutput(selected)) return [theme.fg("dim", `${selected.extension.toUpperCase()} has no inline text preview.`), theme.fg("muted", "Press R to read in chat or C to copy its path.")].slice(0, count);
		if (this.previewLoading) return [theme.fg("accent", "Loading preview…")];
		if (this.previewError) return [theme.fg("warning", `Preview unavailable · ${this.previewError}`)];
		if (!this.preview || !this.previewDocument) return [theme.fg("dim", "Preview unavailable.")];
		if (this.previewWidth !== width || !this.previewLinesCache) {
			this.previewLinesCache = this.previewDocument.render(width).map((line) => truncateToWidth(line, width, width > 1 ? "…" : ""));
			this.previewWidth = width;
		}
		const lines = this.previewLinesCache.length ? [...this.previewLinesCache] : [theme.fg("dim", "(empty file)")];
		if (this.preview.truncated && lines.length < count) lines.push(theme.fg("dim", "… shortened · Enter opens the full reader"));
		return lines.slice(0, count);
	}

	private splitLine(left: string, right: string, width: number, selected = false): string {
		const available = Math.max(2, width - 7);
		const leftWidth = Math.floor(available * 0.42);
		const rightWidth = available - leftWidth;
		const theme = this.options.theme();
		const fit = (value: string, size: number) => {
			const text = truncateToWidth(value, size, size > 1 ? "…" : "");
			return text + " ".repeat(Math.max(0, size - visibleWidth(text)));
		};
		const leftBg = selected ? "selectedBg" : theme.colors.customMessageBg;
		const leftCell = theme.style(fit(left, leftWidth), { bg: leftBg });
		const rightCell = theme.style(fit(right, rightWidth), { bg: theme.colors.customMessageBg });
		const border = theme.fg("borderMuted", "│");
		return `${border} ${leftCell} ${border} ${rightCell} ${border}`;
	}

	private renderWide(width: number, height: number): string[] {
		const list = this.currentItems();
		const lines = [
			this.top(width),
			this.frameLine(this.titleLine(), width),
			this.frameLine(this.groupLine(), width),
			this.frameLine(this.searchLine(width), width),
			this.divider(width),
		];
		const previewWidth = Math.max(1, width - 7 - Math.floor((width - 7) * 0.42));
		lines.push(this.splitLine(this.listHeading(), this.previewHeading(), width));
		const bodyRows = Math.max(1, height - lines.length - 4);
		this.listPageSize = bodyRows;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(bodyRows / 2), list.length - bodyRows));
		const previews = this.previewLines(previewWidth, bodyRows);
		for (let offset = 0; offset < bodyRows; offset += 1) {
			const index = start + offset;
			const item = list[index];
			lines.push(this.splitLine(item ? this.fileLabel(item, index === this.selectedIndex) : "", previews[offset] ?? "", width, index === this.selectedIndex));
		}
		lines.push(this.divider(width), this.frameLine(this.statusLine(), width), this.frameLine(this.helpLine(width), width), this.bottom(width));
		return lines;
	}

	private renderStacked(width: number, height: number): string[] {
		const list = this.currentItems();
		const lines = [
			this.top(width),
			this.frameLine(this.titleLine(), width),
			this.frameLine(this.groupLine(), width),
			this.frameLine(this.searchLine(width), width),
			this.divider(width),
			this.frameLine(this.listHeading(), width),
		];
		const remaining = Math.max(2, height - lines.length - 5);
		const listRows = Math.max(1, Math.min(Math.max(1, list.length), Math.ceil(remaining * 0.42)));
		const previewRows = Math.max(1, remaining - listRows);
		this.listPageSize = listRows;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(listRows / 2), list.length - listRows));
		for (let offset = 0; offset < listRows; offset += 1) {
			const index = start + offset;
			const item = list[index];
			lines.push(this.frameLine(item ? this.fileLabel(item, index === this.selectedIndex) : "", width, index === this.selectedIndex));
		}
		lines.push(this.divider(width), this.frameLine(this.previewHeading(), width));
		for (const line of this.previewLines(Math.max(1, width - 4), previewRows)) lines.push(this.frameLine(` ${line} `, width));
		lines.push(this.frameLine(this.statusLine(), width), this.frameLine(this.helpLine(width), width), this.bottom(width));
		return lines.slice(0, height);
	}

	private renderCompact(width: number, height: number): string[] {
		const lines = [
			this.top(width),
			this.frameLine(this.titleLine(), width),
			this.frameLine(this.groupLine(), width),
			this.frameLine(this.searchLine(width), width),
			this.divider(width),
			this.frameLine(this.listHeading(), width),
		];
		const listRows = Math.max(0, height - lines.length - 2);
		this.listPageSize = Math.max(1, listRows);
		const items = this.currentItems();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(listRows / 2), items.length - listRows));
		for (let offset = 0; offset < listRows; offset += 1) {
			const index = start + offset;
			const item = items[index];
			lines.push(this.frameLine(item ? this.fileLabel(item, index === this.selectedIndex) : "", width, index === this.selectedIndex));
		}
		lines.push(this.frameLine(this.helpLine(width), width), this.bottom(width));
		return lines.slice(0, height);
	}
}

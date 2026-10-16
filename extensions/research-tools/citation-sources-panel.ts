import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { CitationSource } from "./citation-sources.js";

type PanelTUI = Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
type PanelOptions = {
	sources: readonly CitationSource[];
	theme: () => Theme;
	copyUrl: (url: string) => Promise<void>;
	openUrl: (url: string, onError: (message: string) => void) => void;
	done: () => void;
};

export class CitationSourcesPanel implements Component, Focusable {
	private hasFocus = false;
	private editingFilter = false;
	private filterText = "";
	private selectedIndex = 0;
	private scrollTop = 0;
	private notice = "";
	private disposed = false;
	private readonly filter = new Input({ prompt: "/ ", placeholder: "Filter title, ID, URL, status" });

	constructor(private readonly tui: PanelTUI, private readonly options: PanelOptions) {
		this.filter.onSubmit = (value) => {
			this.filterText = value.trim(); this.selectedIndex = 0; this.scrollTop = 0;
			this.editingFilter = false; this.filter.focused = false; this.tui.requestRender();
		};
		this.filter.onEscape = () => {
			this.editingFilter = false; this.filter.focused = false; this.tui.requestRender();
		};
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.filter.focused = value && this.editingFilter; }
	dispose(): void { this.disposed = true; }
	invalidate(): void { this.filter.invalidate(); }

	private filteredSources(): CitationSource[] {
		const query = this.filterText.toLocaleLowerCase();
		return query ? this.options.sources.filter((source) => [source.title, source.identifier, source.url, source.verification]
			.some((value) => value?.toLocaleLowerCase().includes(query))) : [...this.options.sources];
	}

	private async copy(source: CitationSource): Promise<void> {
		this.notice = "Copying URL…"; this.tui.requestRender();
		try { await this.options.copyUrl(source.url); this.notice = "URL copied"; }
		catch (error) { this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`; }
		if (!this.disposed) this.tui.requestRender();
	}

	private open(source: CitationSource): void {
		this.notice = "Opening source in browser…";
		this.options.openUrl(source.url, (message) => {
			this.notice = `Open failed: ${message}`;
			if (!this.disposed) this.tui.requestRender();
		});
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.editingFilter) { this.filter.handleInput(data); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.options.done(); return; }
		if (data === "/") {
			this.editingFilter = true; this.filter.setValue(this.filterText); this.filter.focused = this.hasFocus;
		} else if (matchesKey(data, Key.up)) this.selectedIndex--;
		else if (matchesKey(data, Key.down)) this.selectedIndex++;
		else if (matchesKey(data, Key.pageUp)) this.selectedIndex -= this.pageSize();
		else if (matchesKey(data, Key.pageDown)) this.selectedIndex += this.pageSize();
		else if (matchesKey(data, Key.home)) this.selectedIndex = 0;
		else if (matchesKey(data, Key.end)) this.selectedIndex = this.filteredSources().length - 1;
		else if (matchesKey(data, Key.enter)) {
			const source = this.filteredSources()[this.selectedIndex];
			if (source) this.open(source);
			return;
		} else if (data === "c" || data === "C") {
			const source = this.filteredSources()[this.selectedIndex];
			if (source) void this.copy(source);
			return;
		} else return;
		this.clampSelection(); this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		this.selectedIndex += Math.trunc(event.wheelDelta);
		this.clampSelection();
		return { handled: true, render: true };
	}

	private pageSize(): number { return Math.max(1, Math.min(5, this.tui.terminal.rows - 14)); }

	private clampSelection(): void {
		const count = this.filteredSources().length;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		if (this.selectedIndex >= this.scrollTop + this.pageSize()) this.scrollTop = this.selectedIndex - this.pageSize() + 1;
	}

	private row(text: string, width: number, theme: Theme, selected = false): string {
		const inner = Math.max(0, width - 4);
		const content = truncateToWidth(text, inner, inner > 1 ? "…" : "");
		const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
		const body = `${theme.fg("borderMuted", "│")} ${content}${padding} ${theme.fg("borderMuted", "│")}`;
		return theme.style(body, { bg: selected ? theme.colors.selectedBg : theme.colors.customMessageBg });
	}

	private border(text: string, width: number, theme: Theme): string {
		const inner = Math.max(0, width - 2);
		const content = truncateToWidth(text, inner, inner > 1 ? "…" : "");
		return theme.style(`${theme.fg("borderMuted", "╭")}${content}${theme.fg("borderMuted", "─".repeat(Math.max(0, inner - visibleWidth(content))))}${theme.fg("borderMuted", "╮")}`, { bg: theme.colors.customMessageBg });
	}

	private bottom(width: number, theme: Theme): string {
		return theme.style(`${theme.fg("borderMuted", "╰")}${theme.fg("borderMuted", "─".repeat(Math.max(0, width - 2)))}${theme.fg("borderMuted", "╯")}`, { bg: theme.colors.customMessageBg });
	}

	render(width: number): string[] {
		if (width < 20) return [];
		const theme = this.options.theme();
		const sources = this.filteredSources();
		this.clampSelection();
		const end = Math.min(sources.length, this.scrollTop + this.pageSize());
		const selected = sources[this.selectedIndex];
		const top = this.border(`${theme.fg("accent", theme.bold(" Sources "))}${theme.fg("muted", `latest answer · ${sources.length}${this.filterText ? ` match${sources.length === 1 ? "" : "es"}` : " sources"} · ${sources.length ? this.selectedIndex + 1 : 0}/${sources.length}`)}`, width, theme);
		const list = sources.slice(this.scrollTop, end).map((source, index) => {
			const absoluteIndex = this.scrollTop + index;
			const mark = absoluteIndex === this.selectedIndex ? theme.fg("accent", "▸ ") : theme.fg("dim", "· ");
			const status = source.verification ? `  ${source.verification}` : "";
			const color = source.verification === "verified" ? "success" : source.verification === "blocked" ? "error" : source.verification === "unverified" ? "warning" : "muted";
			return this.row(`${mark}${theme.bold(source.title)}${status ? theme.fg(color, status) : ""}`, width, theme, absoluteIndex === this.selectedIndex);
		});
		if (!list.length) list.push(this.row(this.filterText ? "No sources match this filter" : "No sources", width, theme));
		const detail = selected ? [
			this.row(theme.fg("accent", theme.bold(selected.title)), width, theme),
			this.row(theme.fg("muted", `ID  ${selected.identifier ?? "not identified"}`), width, theme),
			this.row(theme.fg("muted", `URL ${selected.url}`), width, theme),
			this.row(selected.verification
				? `${theme.fg("muted", "Verification  ")}${theme.fg(selected.verification === "verified" ? "success" : selected.verification === "blocked" ? "error" : selected.verification === "unverified" ? "warning" : "muted", selected.verification)}`
				: theme.fg("dim", "Verification  not stated in the answer"), width, theme),
		] : [];
		const filter = this.editingFilter ? this.filter.render(Math.max(1, width - 4))[0] ?? "" : `${theme.fg("accent", "/")} ${theme.fg("muted", "filter sources")}${this.filterText ? ` · ${theme.fg("text", this.filterText)}` : ""}`;
		const help = width < 75 ? "↑↓/wheel move · Enter open · c URL · / filter · Esc" : "↑↓/wheel move · PgUp/PgDn · Enter open · c copy URL · / filter · Esc close";
		return [
			top,
			this.row(filter, width, theme),
			...list,
			this.row(theme.fg("borderMuted", "─".repeat(Math.max(1, width - 4))), width, theme),
			...detail,
			this.row(theme.fg(this.notice.includes("failed") ? "error" : "dim", this.notice || help), width, theme),
			this.bottom(width, theme),
		];
	}
}

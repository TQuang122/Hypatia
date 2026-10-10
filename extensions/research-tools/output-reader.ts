import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, Markdown, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { oneLine, type OutputPreview } from "./output-artifacts.js";

export type OutputReaderAction = "back" | "related" | "read";
export type OutputReaderTUI = Pick<TUI, "requestRender"> & {
	terminal: Pick<TUI["terminal"], "rows">;
};
export type OutputReaderTheme = Pick<Theme, "bold" | "fg" | "style"> & {
	colors: Pick<Theme["colors"], "customMessageBg" | "searchMatchBg">;
};
type ReaderOptions = {
	preview: OutputPreview; relatedLabel?: string; theme: () => OutputReaderTheme;
	copyPath: () => Promise<void>; done: (action: OutputReaderAction) => void;
};

export class OutputReader implements Component, Focusable {
	private document: Markdown | Text;
	private rows: string[] = [];
	private width = -1;
	private scrollTop = 0;
	private pageHeight = 18;
	private query = "";
	private matches: number[] = [];
	private matchIndex = -1;
	private editingSearch = false;
	private readonly search = new Input({ prompt: "/ ", placeholder: "Find text in visible content" });
	private hasFocus = false;
	private copying = false;
	private disposed = false;
	private notice = "";

	constructor(private readonly tui: OutputReaderTUI, private readonly options: ReaderOptions) {
		this.document = this.createDocument();
		this.search.onSubmit = (value) => {
			this.query = oneLine(value);
			this.editingSearch = false;
			this.search.focused = false;
			this.findMatches();
			if (this.matches.length) this.goToMatch(0);
			this.tui.requestRender();
		};
		this.search.onEscape = () => {
			this.editingSearch = false;
			this.search.focused = false;
			this.tui.requestRender();
		};
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.search.focused = value && this.editingSearch; }
	dispose(): void { this.disposed = true; }
	invalidate(): void { this.document = this.createDocument(); this.width = -1; this.search.invalidate(); }

	private createDocument(): Markdown | Text {
		return this.options.preview.markdown
			? new Markdown(this.options.preview.content, 0, 0, getMarkdownTheme())
			: new Text(this.options.preview.content, 0, 0);
	}

	private findMatches(): void {
		const query = this.query.toLocaleLowerCase();
		this.matches = query ? this.rows.flatMap((row, index) => stripVTControlCharacters(row).toLocaleLowerCase().includes(query) ? [index] : []) : [];
		this.matchIndex = this.matches.length ? Math.max(0, Math.min(this.matchIndex, this.matches.length - 1)) : -1;
	}

	private goToMatch(index: number): void {
		if (!this.matches.length) return;
		this.matchIndex = (index + this.matches.length) % this.matches.length;
		this.scrollTop = Math.min(this.matches[this.matchIndex], Math.max(0, this.rows.length - this.pageHeight));
	}

	private scroll(delta: number): void {
		this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, Math.max(0, this.rows.length - this.pageHeight)));
	}

	private async copy(): Promise<void> {
		if (this.copying) return;
		this.copying = true;
		this.notice = "Copying path…";
		this.tui.requestRender();
		try { await this.options.copyPath(); this.notice = "Path copied"; }
		catch (error) { this.notice = `Copy failed: ${oneLine(error instanceof Error ? error.message : String(error))}`; }
		finally { this.copying = false; if (!this.disposed) this.tui.requestRender(); }
	}

	handleInput(data: string): void {
		if (this.editingSearch) {
			if (matchesKey(data, Key.ctrl("c"))) { this.editingSearch = false; this.search.focused = false; }
			else this.search.handleInput(data);
			this.tui.requestRender(); return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.options.done("back"); return; }
		if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
			this.editingSearch = true; this.search.setValue(this.query); this.search.focused = this.focused;
		} else if (matchesKey(data, Key.down)) this.scroll(1);
		else if (matchesKey(data, Key.up)) this.scroll(-1);
		else if (matchesKey(data, Key.pageDown)) this.scroll(this.pageHeight);
		else if (matchesKey(data, Key.pageUp)) this.scroll(-this.pageHeight);
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = Math.max(0, this.rows.length - this.pageHeight);
		else if (data === "n") this.goToMatch(this.matchIndex + 1);
		else if (data === "N") this.goToMatch(this.matchIndex - 1);
		else if (data === "c") { void this.copy(); return; }
		else if (data === "p" && this.options.relatedLabel) { this.options.done("related"); return; }
		else if (data === "r") { this.options.done("read"); return; }
		else return;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		this.scroll(event.wheelDelta);
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.options.theme();
		const horizontalPadding = width >= 3 ? 1 : 0;
		const contentWidth = Math.max(1, width - horizontalPadding * 2);
		const fit = (value: string) => truncateToWidth(value, contentWidth, contentWidth > 1 ? "…" : "");
		const surface = (value: string, match = false): string => {
			const text = fit(value);
			const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(text)));
			const row = `${" ".repeat(horizontalPadding)}${text}${padding}${" ".repeat(horizontalPadding)}`;
			return theme.style(row, match
				? { fg: "searchMatchText", bg: theme.colors.searchMatchBg }
				: { bg: theme.colors.customMessageBg });
		};
		this.pageHeight = Math.max(1, this.tui.terminal.rows - 4);
		if (this.width !== contentWidth) {
			this.rows = this.document.render(contentWidth).map(fit);
			if (!this.rows.length) this.rows = [theme.fg("dim", "(empty file)")];
			this.width = contentWidth;
			this.findMatches();
		}
		this.scroll(0);
		const body = this.rows.slice(this.scrollTop, this.scrollTop + this.pageHeight).map((row, index) => {
			const match = this.matches[this.matchIndex] === this.scrollTop + index;
			return surface(match ? stripVTControlCharacters(row) : row, match);
		});
		const visibleBodyCount = body.length;
		while (body.length < this.pageHeight) body.push(surface(""));
		const position = `${this.scrollTop + 1}–${Math.min(this.scrollTop + visibleBodyCount, this.rows.length)}/${this.rows.length} rows`;
		const searchStatus = this.query ? ` · ${this.matches.length ? `${this.matchIndex + 1}/${this.matches.length} matching rows` : "no matches"}: ${this.query}` : "";
		const status = this.editingSearch ? this.search.render(contentWidth)[0] ?? "" : theme.fg("dim", fit(this.notice || `${position}${searchStatus}`));
		const help = contentWidth < 60
			? `Esc · / find · c path${this.options.relatedLabel ? " · p pair" : ""}`
			: `Esc back · ↑↓/Pg scroll · / find · n/N next · c path${this.options.relatedLabel ? ` · p ${this.options.relatedLabel}` : ""} · r chat`;
		return [
			surface(theme.fg("accent", theme.bold(this.options.preview.artifact.title || this.options.preview.artifact.group))),
			surface(theme.fg("dim", oneLine(this.options.preview.artifact.path))),
			...body,
			surface(status),
			surface(theme.fg("dim", help)),
		];
	}
}

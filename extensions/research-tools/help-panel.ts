import { Input, Key, matchesKey, Text, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type HelpPanelCommand = { usage: string; prefill: string; description: string; section: string };

export class HelpPanel implements Component, Focusable {
	private hasFocus = false;
	private editingSearch = false;
	private query = "";
	private cursor = 0;
	private scrollTop = 0;
	private readonly search = new Input({ prompt: "/ ", placeholder: "Filter Hypatia commands" });

	constructor(
		private readonly tui: Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> },
		private readonly theme: Theme,
		private readonly commands: readonly HelpPanelCommand[],
		private readonly select: (command: HelpPanelCommand) => void,
		private readonly done: () => void,
	) {
		this.search.onSubmit = (value) => {
			this.query = value.trim(); this.cursor = 0; this.scrollTop = 0;
			this.editingSearch = false; this.search.focused = false; this.tui.requestRender();
		};
		this.search.onEscape = () => { this.editingSearch = false; this.search.focused = false; this.tui.requestRender(); };
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.search.focused = value && this.editingSearch; }
	invalidate(): void { this.search.invalidate(); }

	private filtered(): HelpPanelCommand[] {
		const query = this.query.toLocaleLowerCase();
		return query ? this.commands.filter((command) => `${command.usage} ${command.section} ${command.description}`.toLocaleLowerCase().includes(query)) : [...this.commands];
	}

	private pageSize(): number { return Math.max(1, Math.min(8, Math.floor((this.tui.terminal.rows - 14) * 0.5))); }

	private clamp(): void {
		const count = this.filtered().length;
		this.cursor = Math.max(0, Math.min(this.cursor, count - 1));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.pageSize()) this.scrollTop = this.cursor - this.pageSize() + 1;
	}

	handleInput(data: string): void {
		if (this.editingSearch) { this.search.handleInput(data); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(); return; }
		if (data === "/") { this.editingSearch = true; this.search.setValue(this.query); this.search.focused = this.hasFocus; }
		else if (matchesKey(data, Key.up)) this.cursor--;
		else if (matchesKey(data, Key.down)) this.cursor++;
		else if (matchesKey(data, Key.pageUp)) this.cursor -= this.pageSize();
		else if (matchesKey(data, Key.pageDown)) this.cursor += this.pageSize();
		else if (matchesKey(data, Key.home)) this.cursor = 0;
		else if (matchesKey(data, Key.end)) this.cursor = this.filtered().length - 1;
		else if (matchesKey(data, Key.enter)) {
			const command = this.filtered()[this.cursor];
			if (command) this.select(command);
			this.done();
			return;
		} else return;
		this.clamp(); this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		this.cursor += event.wheelDelta; this.clamp();
		return { handled: true, render: true };
	}

	private row(content: string, width: number, selected = false): string {
		const inner = Math.max(0, width - 4);
		const text = truncateToWidth(content, inner, inner > 1 ? "…" : "");
		const padding = " ".repeat(Math.max(0, inner - visibleWidth(text)));
		return this.theme.style(`${this.theme.fg("borderMuted", "│")} ${text}${padding} ${this.theme.fg("borderMuted", "│")}`, {
			bg: selected ? this.theme.colors.selectedBg : this.theme.colors.customMessageBg,
		});
	}

	private border(text: string, width: number): string {
		const inner = Math.max(0, width - 2);
		const label = truncateToWidth(text, inner, inner > 1 ? "…" : "");
		return this.theme.style(`${this.theme.fg("borderMuted", "╭")}${label}${this.theme.fg("borderMuted", "─".repeat(Math.max(0, inner - visibleWidth(label))))}${this.theme.fg("borderMuted", "╮")}`, { bg: this.theme.colors.customMessageBg });
	}

	render(width: number): string[] {
		if (width < 24) return [];
		const commands = this.filtered();
		this.clamp();
		const pageSize = this.pageSize();
		const start = Math.min(this.scrollTop, Math.max(0, commands.length - pageSize));
		const end = Math.min(commands.length, start + pageSize);
		const selected = commands[this.cursor];
		const header = `${this.theme.fg("accent", this.theme.bold(" Hypatia Help "))}${this.theme.fg("muted", ` ${commands.length}${this.query ? " matches" : " commands"}`)}`;
		const list = commands.slice(start, end).map((command, offset) => {
			const active = start + offset === this.cursor;
			const usageWidth = Math.min(38, Math.floor(width * 0.55));
			const usage = truncateToWidth(command.usage, usageWidth, usageWidth > 1 ? "…" : "");
			const left = `${active ? this.theme.fg("accent", "▸ ") : this.theme.fg("dim", "· ")}${this.theme.bold(usage)}`;
			const section = width >= 72 ? this.theme.fg("muted", command.section) : "";
			return this.row(`${left}  ${section}`, width, active);
		});
		if (!list.length) list.push(this.row(this.theme.fg("muted", "No commands match this filter"), width));
		const detail = selected ? [
			this.row(this.theme.fg("accent", this.theme.bold(selected.usage)), width),
			...new Text(selected.description, 0, 0).render(Math.max(1, width - 6)).slice(0, 3).map((line) => this.row(this.theme.fg("text", line), width)),
		] : [];
		const filter = this.editingSearch ? this.search.render(Math.max(1, width - 4))[0] ?? "" : `${this.theme.fg("accent", "/")} ${this.theme.fg("muted", "filter commands")}${this.query ? ` · ${this.theme.fg("text", this.query)}` : ""}`;
		const position = commands.length ? `${this.cursor + 1}/${commands.length}` : "0/0";
		const help = width < 64 ? `Enter prefill · ↑↓ move · / filter · ${position} · Esc close` : `Enter prefill · ↑↓/PgUp/PgDn move · / filter · ${position} · Esc close`;
		return [
			this.border(header, width),
			this.row(filter, width),
			...list,
			this.row(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width - 4))), width),
			...detail,
			this.row(this.theme.fg("dim", help), width),
			this.theme.style(`${this.theme.fg("borderMuted", "╰")}${this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 2)))}${this.theme.fg("borderMuted", "╯")}`, { bg: this.theme.colors.customMessageBg }),
		];
	}
}

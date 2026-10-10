import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { getAgentDir, ModelRuntime, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";

export interface IdeaModelOption {
	spec: string;
	identity: string;
	isCurrent: boolean;
}

class IdeaModelSelector implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (models: string[] | undefined) => void;
	private readonly models: IdeaModelOption[];
	private readonly selected = new Set<string>();
	private target = 1;
	private cursor = 0;
	private status = "";

	constructor(tui: TUI, theme: Theme, models: IdeaModelOption[], done: (models: string[] | undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.models = models;
		this.done = done;
		const current = models.find(model => model.isCurrent) ?? models[0];
		if (current) {
			this.selected.add(current.spec);
			this.cursor = models.indexOf(current);
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		this.status = "";
		if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, Key.down)) this.cursor = Math.min(this.models.length - 1, this.cursor + 1);
		else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.pageSize());
		else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(this.models.length - 1, this.cursor + this.pageSize());
		else if (matchesKey(data, Key.home)) this.cursor = 0;
		else if (matchesKey(data, Key.end)) this.cursor = this.models.length - 1;
		else if (matchesKey(data, Key.left) || data === "1") this.setTarget(1);
		else if (matchesKey(data, Key.right) || data === "3") this.setTarget(3);
		else if (matchesKey(data, Key.space) || data === " ") this.toggleCurrent();
		else if (matchesKey(data, Key.enter)) {
			if (this.selected.size !== this.target) this.status = `Select exactly ${this.target} distinct model${this.target === 1 ? "" : "s"} before continuing.`;
			else this.done(this.models.filter(model => this.selected.has(model.spec)).map(model => model.spec));
			this.tui.requestRender();
			return;
		} else return;
		this.tui.requestRender();
	}

	private pageSize(): number {
		return Math.max(3, Math.min(10, this.tui.terminal.rows - 20));
	}

	private setTarget(target: 1 | 3): void {
		if (target === 3 && new Set(this.models.map(model => model.identity)).size < 3) {
			this.status = "A three-model panel needs three distinct available models.";
			return;
		}
		this.target = target;
		if (target === 1 && this.selected.size > 1) {
			const keep = this.models[this.cursor] && this.selected.has(this.models[this.cursor]!.spec)
				? this.models[this.cursor]!.spec
				: this.models.find(model => this.selected.has(model.spec))?.spec;
			this.selected.clear();
			if (keep) this.selected.add(keep);
		}
		this.status = "";
	}

	private toggleCurrent(): void {
		const current = this.models[this.cursor];
		if (!current) return;
		if (this.target === 1) {
			this.selected.clear();
			this.selected.add(current.spec);
			return;
		}
		if (this.selected.has(current.spec)) {
			this.selected.delete(current.spec);
			return;
		}
		if ([...this.selected].some(spec => this.models.find(model => model.spec === spec)?.identity === current.identity)) {
			this.status = "Choose distinct model identities; this model duplicates one already selected.";
			return;
		}
		if (this.selected.size >= this.target) {
			this.status = `The ${this.target}-model panel is full. Unselect a model first.`;
			return;
		}
		this.selected.add(current.spec);
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const pageSize = this.pageSize();
		const start = Math.max(0, Math.min(this.cursor - pageSize + 1, this.models.length - pageSize));
		const visible = this.models.slice(start, start + pageSize);
		const mode = this.target === 1 ? "1 model" : "3 models";
		const rows = [
			this.theme.fg("accent", this.theme.bold("Idea Forge · Choose model panel")),
			`Panel size: ${this.theme.fg(this.target === 1 ? "accent" : "muted", this.target === 1 ? "[1] One model" : "1 One model")}   ${this.theme.fg(this.target === 3 ? "accent" : "muted", this.target === 3 ? "[3] Three models" : "3 Three models")}`,
			`Selected ${this.selected.size}/${this.target} · ${mode}`,
			...visible.map((model, offset) => {
				const index = start + offset;
				const active = index === this.cursor;
				const checked = this.selected.has(model.spec);
				const marker = `${active ? "›" : " "} ${checked ? "[x]" : "[ ]"} `;
				const label = `${model.spec}${model.isCurrent ? " · current" : ""}`;
				return `${active ? this.theme.fg("accent", marker) : marker}${checked ? this.theme.fg("success", label) : label}`;
			}),
			...(this.models.length > pageSize ? [`Models ${start + 1}–${Math.min(start + pageSize, this.models.length)} of ${this.models.length}`] : []),
			...(this.status ? [this.theme.fg("warning", this.status)] : []),
			this.theme.fg("dim", "↑↓ move · Space select · 1/3 or ←→ panel size · Enter continue · Esc cancel"),
		];
		const innerWidth = Math.max(1, width - 2);
		const surface = (value: string) => {
			const text = truncateToWidth(value, innerWidth, innerWidth > 1 ? "…" : "");
			const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
			return this.theme.style(` ${text}${padding} `, { bg: this.theme.colors.customMessageBg });
		};
		const border = this.theme.style(`╭${"─".repeat(Math.max(0, width - 2))}╮`, { fg: "accent", bg: this.theme.colors.customMessageBg });
		return [border, ...rows.map(surface), this.theme.style(`╰${"─".repeat(Math.max(0, width - 2))}╯`, { fg: "accent", bg: this.theme.colors.customMessageBg })];
	}
}

function modelIdentity(spec: string): string {
	return spec.slice(spec.indexOf("/") + 1).toLowerCase();
}

export async function selectIdeaModelPanel(ctx: ExtensionCommandContext): Promise<string[] | undefined> {
	if (ctx.mode !== "tui" || !ctx.ui.custom) {
		ctx.ui.notify("Interactive model selector is unavailable here; Idea Forge will use the current model.", "info");
		return ctx.model ? [`${ctx.model.provider}/${ctx.model.id}`] : [];
	}
	const agentDir = getAgentDir();
	const runtime = await ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsPath: `${agentDir}/models.json`,
		allowModelNetwork: false,
		signal: ctx.signal,
	});
	let available = await runtime.getAvailable(undefined, { signal: ctx.signal });
	const scopedModels = ctx.scopedModels ?? [];
	if (scopedModels.length > 0) {
		const scoped = new Set(scopedModels.map(item => `${item.model.provider}/${item.model.id}`));
		available = available.filter(model => scoped.has(`${model.provider}/${model.id}`));
	}
	const models = available
		.map(model => ({ spec: `${model.provider}/${model.id}`, identity: modelIdentity(model.id), isCurrent: ctx.model?.provider === model.provider && ctx.model.id === model.id }))
		.sort((left, right) => left.spec.localeCompare(right.spec));
	if (!models.length) {
		ctx.ui.notify("No available Hypatia models for Idea Forge. Configure a model with /model first.", "error");
		return undefined;
	}
	return ctx.ui.custom<string[] | undefined>((tui, theme, _keys, done) => new IdeaModelSelector(tui, theme, models, done), {
		overlay: true,
		overlayOptions: { anchor: "bottom-center", width: "96%", maxHeight: "58%", offsetY: -6, margin: { left: 1, right: 1, top: 1, bottom: 1 } },
	});
}

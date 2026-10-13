import { stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Container, Key, matchesKey, Text, truncateToWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DefaultPackageManager, getAgentDir, loadSkills, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { scrubSecretsText } from "./secret-scrubber.js";
import { registerModelErrorGuidance } from "./model-error-guidance.js";

export const WARNING_STATUS_KEY = "hypatia-warnings";
const UI_BRIDGE_KEY = "__hypatiaWarningNotifyBridge";
const MAX_WARNINGS = 100;
type WarningRecord = { id: number; text: string; time: number };
type WarningBridge = { original: ExtensionUIContext["notify"]; onWarning?: (message: string) => void };
type BridgeUI = ExtensionUIContext & { __hypatiaWarningNotifyBridge?: WarningBridge };

function displayText(message: string): string {
	return scrubSecretsText(stripVTControlCharacters(message)).text
		.replace(/\r\n?/gu, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, " ").trim();
}

function oneLine(message: string): string {
	return truncateToWidth(displayText(message).split("\n").find((line) => line.trim())?.trim() ?? "Warning", 88, "…");
}

function compactSkillPath(filePath: string, cwd: string): string {
	const absolute = resolve(filePath);
	const home = resolve(homedir());
	if (absolute === home) return "~";
	if (absolute.startsWith(`${home}${sep}`)) return `~${absolute.slice(home.length)}`;
	const fromCwd = relative(cwd, absolute);
	return fromCwd && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd) ? fromCwd : absolute;
}

/** Ask Pi's own resolver for skill collision diagnostics without installing missing packages. */
export async function collectSkillConflictWarnings(cwd: string, projectTrusted: boolean): Promise<string[]> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const loaded = loadSkills({
		cwd,
		agentDir,
		skillPaths: resolved.skills.filter((skill) => skill.enabled).map((skill) => skill.path),
		includeDefaults: false,
	});
	const groups = new Map<string, { winnerPath: string; loserPaths: Set<string> }>();
	for (const diagnostic of loaded.diagnostics) {
		if (diagnostic.type !== "collision" || diagnostic.collision?.resourceType !== "skill") continue;
		const collision = diagnostic.collision;
		const group = groups.get(collision.name) ?? { winnerPath: collision.winnerPath, loserPaths: new Set<string>() };
		group.loserPaths.add(collision.loserPath);
		groups.set(collision.name, group);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [
		`Skill "${name}" collision:`,
		`  ✓ ${compactSkillPath(group.winnerPath, cwd)}`,
		...[...group.loserPaths].map((path) => `  ✗ ${compactSkillPath(path, cwd)} (skipped)`),
	].join("\n"));
}

class WarningDetail implements Component, Focusable {
	focused = false;
	private width = -1;
	private rows: string[] = [];
	private scrollTop = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly warning: WarningRecord,
		private readonly index: number,
		private readonly count: number,
		private readonly dismiss: () => void,
		private readonly done: () => void,
	) {}

	invalidate(): void { this.width = -1; }

	private scroll(delta: number): void {
		const page = Math.max(1, Math.min(18, this.tui.terminal.rows - 6));
		this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, Math.max(0, this.rows.length - page)));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(); return; }
		if (matchesKey(data, Key.up)) this.scroll(-1);
		else if (matchesKey(data, Key.down)) this.scroll(1);
		else if (matchesKey(data, Key.pageUp)) this.scroll(-Math.max(1, Math.min(18, this.tui.terminal.rows - 6)));
		else if (matchesKey(data, Key.pageDown)) this.scroll(Math.max(1, Math.min(18, this.tui.terminal.rows - 6)));
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = this.rows.length;
		else if (data === "d" || data === "D") { this.dismiss(); return; }
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
		const bodyWidth = Math.max(1, width - 2);
		if (this.width !== bodyWidth) {
			this.rows = new Text(displayText(this.warning.text), 0, 0).render(bodyWidth);
			if (!this.rows.length) this.rows = ["(empty warning)"];
			this.width = bodyWidth;
			this.scrollTop = Math.min(this.scrollTop, Math.max(0, this.rows.length - 1));
		}
		const page = Math.max(1, Math.min(18, this.tui.terminal.rows - 6));
		const visible = this.rows.slice(this.scrollTop, this.scrollTop + page);
		const range = `${this.scrollTop + 1}–${Math.min(this.rows.length, this.scrollTop + visible.length)}/${this.rows.length}`;
		return [
			this.theme.fg("warning", this.theme.bold(`Warning ${this.index + 1} of ${this.count}`)),
			this.theme.fg("dim", new Date(this.warning.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
			"",
			...visible,
			this.theme.fg("dim", `${range} · ↑↓/Pg scroll · d dismiss · Esc back`),
		];
	}
}

export function registerWarningCenter(pi: ExtensionAPI): void {
	registerModelErrorGuidance(pi);
	let context: ExtensionContext | undefined;
	let warnings: WarningRecord[] = [];
	let overflowCount = 0;
	let nextId = 1;
	let bridge: WarningBridge | undefined;

	const updateStatus = (): void => {
		if (!context || context.mode !== "tui" || !context.hasUI) return;
		const count = warnings.length + overflowCount;
		context.ui.setStatus(WARNING_STATUS_KEY, count > 0 ? `⚠ ${count} warning${count === 1 ? "" : "s"} · F2 to view` : undefined);
	};
	const addWarning = (message: string): void => {
		const text = displayText(message);
		if (!text) return;
		if (warnings.length === MAX_WARNINGS) { warnings.shift(); overflowCount += 1; }
		warnings.push({ id: nextId++, text, time: Date.now() });
		updateStatus();
	};
	const openWarnings = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		while (true) {
			const visibleWarnings = [...warnings];
			if (!visibleWarnings.length) { ctx.ui.notify("No warnings to view.", "info"); return; }
			const offset = overflowCount;
			const choices = visibleWarnings.map((warning, index) => `${offset + index + 1}. ${oneLine(warning.text)}`);
			const choice = await ctx.ui.select(`Warnings (${overflowCount + warnings.length})`, choices);
			if (!choice) return;
			const index = choices.indexOf(choice);
			const warning = visibleWarnings[index];
			if (!warning) continue;
			await ctx.ui.custom<void>((tui, theme, _keys, done) => new WarningDetail(
				tui, theme, warning, offset + index, overflowCount + visibleWarnings.length,
				() => {
					warnings = warnings.filter((item) => item.id !== warning.id);
					updateStatus();
					done();
				}, done,
			), { overlay: true, overlayOptions: { anchor: "center", width: "92%", margin: 1 } });
		}
	};

	pi.registerShortcut(Key.f2, { description: "View warnings", handler: (ctx) => openWarnings(ctx) });
	pi.on("session_start", async (_event, ctx) => {
		context = ctx; warnings = []; overflowCount = 0; nextId = 1;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const ui = ctx.ui as BridgeUI;
		bridge = ui[UI_BRIDGE_KEY];
		if (!bridge) {
			bridge = { original: ui.notify.bind(ui) };
			Object.defineProperty(ui, UI_BRIDGE_KEY, { value: bridge, configurable: false, enumerable: false });
			ui.notify = (message, type) => {
				if (type === "warning" && bridge?.onWarning) { bridge.onWarning(message); return; }
				bridge?.original(message, type);
			};
		}
		bridge.onWarning = addWarning;
		ctx.ui.setStatus(WARNING_STATUS_KEY, undefined);
		try {
			for (const warning of await collectSkillConflictWarnings(ctx.cwd, ctx.isProjectTrusted())) addWarning(warning);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			addWarning(`Could not inspect skill conflicts: ${message}`);
		}
	});
	pi.on("session_shutdown", () => {
		context?.ui.setStatus(WARNING_STATUS_KEY, undefined);
		if (bridge) bridge.onWarning = undefined;
		context = undefined;
	});
}

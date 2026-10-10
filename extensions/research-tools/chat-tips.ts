import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
import { snapshotTipReports, type ReportSnapshot } from "./chat-tip-artifacts.js";

const WIDGET_KEY = "hypatia-chat-tip";
export type ChatTips = {
	refresh(): void;
	setActivity(busy: boolean, working: boolean): void;
	setWelcomeVisible(visible: boolean): void;
};

function keyName(action: string): string | undefined {
	const bindings = getKeybindings();
	// Pi also registers app.* actions in this registry at runtime; the TUI's
	// public type lists only its own built-in actions.
	return bindings.getKeys(action as Parameters<typeof bindings.getKeys>[0])[0]?.split("+")
		.map((part) => part === "escape" ? "Esc" : part[0].toUpperCase() + part.slice(1)).join("+");
}

export function registerChatTips(pi: ExtensionAPI): ChatTips {
	let current: ExtensionContext | undefined;
	let busy = true, checkingReports = false, workSinceIdle = false;
	let reportChanged = false, hasToolResult = false, widgetVisible = false, welcomeVisible = false;
	let generation = 0, scanSequence = 0;
	let snapshot: ReportSnapshot | undefined;
	let stopInput: (() => void) | undefined;

	const shouldShow = (): boolean => Boolean(current?.mode === "tui" && current.hasUI
		&& !welcomeVisible && !busy && !checkingReports && current.isIdle() && !current.hasPendingMessages()
		&& current.ui.getEditorText().length === 0);
	const tipText = (): string => {
		if (reportChanged) return "Use /outputs to read your report.";
		const expand = keyName("app.tools.expand");
		if (hasToolResult && expand) return `Press ${expand} to expand tool details.`;
		const newline = keyName("tui.input.newLine");
		return [newline && `${newline} for a new line`, "/hotkeys for all shortcuts"].filter(Boolean).join(" · ");
	};
	const refresh = (): void => {
		if (current?.mode !== "tui" || !current.hasUI) return;
		const visible = shouldShow();
		if (visible === widgetVisible) return;
		widgetVisible = visible;
		if (!visible) { current.ui.setWidget(WIDGET_KEY, undefined); return; }
		current.ui.setWidget(WIDGET_KEY, (_tui, initialTheme) => ({
			invalidate() {},
			render(width: number): string[] {
				// Also guard programmatic changes in editors installed by other extensions.
				if (width <= 0 || !shouldShow()) return [];
				const theme = current?.ui.theme ?? initialTheme;
				const padding = pi.getSettings().outputPad === 0 || width < 3 ? 0 : 1;
				return new Text(`${theme.fg("accent", "Tip")} ${theme.fg("dim", "·")} ${theme.fg("muted", tipText())}`, padding, 0).render(width);
			},
		}), { placement: "aboveEditor" });
	};
	const scanReports = async (baseline = false): Promise<void> => {
		const ctx = current;
		if (!ctx) return;
		const epoch = generation, sequence = ++scanSequence;
		checkingReports = true;
		refresh();
		try {
			const next = await snapshotTipReports(ctx.cwd);
			if (epoch !== generation || sequence !== scanSequence || current !== ctx) return;
			if (next.complete) {
				if (!baseline && snapshot?.complete) {
					reportChanged = [...next.revisions].some(([path, revision]) => snapshot!.revisions.get(path) !== revision);
				}
				snapshot = next;
			}
		} catch { /* A failed metadata observation must not become a report claim. */ }
		finally {
			if (epoch === generation && sequence === scanSequence && current === ctx) {
				checkingReports = false;
				refresh();
			}
		}
	};
	const setActivity = (active: boolean, working: boolean): void => {
		workSinceIdle ||= working;
		// New work invalidates an older observation; opening a picker does not.
		if (working && checkingReports) { ++scanSequence; checkingReports = false; }
		if (busy === active) { refresh(); return; }
		busy = active;
		if (active) refresh();
		else if (workSinceIdle) { workSinceIdle = false; void scanReports(); }
		else refresh();
	};
	const setWelcomeVisible = (visible: boolean): void => {
		if (welcomeVisible === visible) return;
		welcomeVisible = visible;
		refresh();
	};

	pi.on("session_start", async (_event, ctx) => {
		stopInput?.(); stopInput = undefined;
		++generation; ++scanSequence;
		current = ctx;
		welcomeVisible = false;
		busy = !ctx.isIdle(); checkingReports = false; workSinceIdle = false;
		reportChanged = false; hasToolResult = false; widgetVisible = false; snapshot = undefined;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		// Observe keys after Pi handles them, without consuming or rewriting input.
		const epoch = generation;
		stopInput = ctx.ui.onTerminalInput(() => {
			queueMicrotask(() => { if (epoch === generation) refresh(); });
			return undefined;
		});
		await scanReports(true);
	});
	pi.on("agent_start", () => {
		if (current?.mode !== "tui" || !current.hasUI) return;
		reportChanged = false; hasToolResult = false; workSinceIdle = true;
		busy = true; ++scanSequence; checkingReports = false;
		refresh();
	});
	pi.on("tool_execution_end", (event) => {
		if (current?.mode === "tui" && current.hasUI && !event.parentToolCallId && !event.isError) hasToolResult = true;
	});
	pi.on("session_shutdown", () => {
		++generation; ++scanSequence;
		stopInput?.(); stopInput = undefined;
		if (current?.mode === "tui" && current.hasUI) current.ui.setWidget(WIDGET_KEY, undefined);
		current = undefined; widgetVisible = false; welcomeVisible = false;
	});
	return { refresh, setActivity, setWelcomeVisible };
}

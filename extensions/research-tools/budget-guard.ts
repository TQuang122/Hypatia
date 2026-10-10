import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function parseToolBudget(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	return value >= 1 ? value : undefined;
}

// Counts top-level tool calls per session (nested calls carry parentToolCallId
// and are not double-counted). Unset or invalid HYPATIA_TOOL_BUDGET means
// unlimited. When the budget is exceeded the call is blocked with a reason.
export function registerBudgetGuard(pi: ExtensionAPI): void {
	let calls = 0;
	pi.on("session_start", () => {
		calls = 0;
		return undefined;
	});
	pi.on("tool_call", (event) => {
		if (event.parentToolCallId) return undefined;
		calls += 1;
		const budget = parseToolBudget(process.env.HYPATIA_TOOL_BUDGET);
		if (budget === undefined || calls <= budget) return undefined;
		return {
			block: true,
			reason: `Tool budget exceeded: ${calls} calls used, budget is ${budget} (HYPATIA_TOOL_BUDGET). Summarize what you have instead of calling more tools.`,
		};
	});
}

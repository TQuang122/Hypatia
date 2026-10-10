import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Context7 serves versioned library documentation: the missing piece for
// replication and ML recipes, where fetch_content only sees raw doc pages.
// Opt-in because it shells out to npx on first use:
// HYPATIA_CONTEXT7=1
export function registerContext7Mcp(pi: ExtensionAPI): void {
	if (process.env.HYPATIA_CONTEXT7?.trim() !== "1") return;
	pi.registerMcpServer("context7", {
		command: "npx",
		args: ["-y", "@upstash/context7-mcp"],
	});
}

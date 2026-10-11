import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function parseFrontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};

	const frontmatter = {};
	for (const line of match[1].split("\n")) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!key) continue;
		frontmatter[key] = value;
	}
	return frontmatter;
}

export function readPromptSpecs(appRoot) {
	const dir = resolve(appRoot, "prompts");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const text = readFileSync(resolve(dir, f), "utf8");
			const fm = parseFrontmatter(text);
			return {
				name: f.replace(/\.md$/, ""),
				description: fm.description ?? "",
				args: fm.args ?? "",
				section: fm.section ?? "Research Workflows",
				topLevelCli: fm.topLevelCli === "true",
			};
		});
}

export const extensionCommandSpecs = [
	{ name: "idea", args: "[research goal]", section: "Project & Session", description: "Choose a one-model or three-model panel above the input; approving the readable, budget-checked contract starts Idea Forge. Defaults: 12 calls, 900s, 5000 tokens/request, 90s/request. Use research-ideation for broad chat-only brainstorming.", publicDocs: true },
	{ name: "experiments", args: "[tree create|list|status <slug>|approve <tree> <node>|fork <tree> <parent> <child> <hypothesis>|promote <tree> <node>|pause|resume|recover|close-node <tree> <node>|close|export <tree>|acknowledge <tree> <node>|generate <goal>|ideas|forge-status|forge-pause|forge-resume|forge-recover|forge-approve <slug>|status|pause|resume|approve|export|close|recover|review <slug>|create <goal>|create-json <contract-file>|import <idea-file>|import-json <idea-file> --contract <contract-file>]", section: "Project & Session", description: "Prepare experiments or native research ideas in chat with /idea, then approve a frozen contract; manage receipts, shared-budget Git worktree trees and recovery.", publicDocs: true },
	{ name: "help", args: "", section: "Project & Session", description: "Show grouped Hypatia commands and prefill the editor with a selected command.", publicDocs: true },
	{ name: "init", args: "", section: "Project & Session", description: "Bootstrap AGENTS.md and session-log folders for a research project.", publicDocs: true },
	{ name: "outputs", args: "", section: "Project & Session", description: "View grouped research reports and provenance in the TUI, search their text, or copy artifact paths.", publicDocs: true },
	{ name: "sources", args: "", section: "Project & Session", description: "Browse citations from the latest assistant answer; open or copy a source URL.", publicDocs: true },
	{ name: "compare-provenance", args: "", section: "Project & Session", description: "Compare verification and source-coverage metadata from two completed research runs.", publicDocs: true },
	{ name: "model-routes", args: "", section: "Agents & Delegation", description: "Configure ordered routes for evidence-scout, scribe, auditor, critic, and reviser; choose Pi-override or parent-model inheritance.", publicDocs: true },
	{ name: "service-tier", args: "", section: "Project & Session", description: "View or set the provider service tier override for supported models.", publicDocs: true },
	{ name: "tools", args: "", section: "Project & Session", description: "Browse public research tools with their source and parameter summary.", publicDocs: true },
];

export const livePackageCommandGroups = [
	{
		title: "Agents & Delegation",
		commands: [
			{ name: "subagents", usage: "/subagents" },
			{ name: "run", usage: "/run <agent> [task] [--bg] [--fork]" },
		],
	},
	{
		title: "Live Package Commands",
		commands: [
			{ name: "search", usage: "/search" },
			{ name: "websearch", usage: "/websearch" },
			{ name: "curator", usage: "/curator" },
			{ name: "hotkeys", usage: "/hotkeys" },
			{ name: "new", usage: "/new" },
			{ name: "quit", usage: "/quit" },
			{ name: "exit", usage: "/exit" },
		],
	},
];

export const livePackageToolGroups = [
	{ title: "Research Experiments", tools: [{ name: "hypatia_experiment" }, { name: "hypatia_idea_forge" }] },
	{
		title: "Web & Source Retrieval",
		tools: [
			{ name: "web_search" },
			{ name: "fetch_content" },
			{ name: "get_search_content" },
			{ name: "code_search" },
		],
	},
	{
		title: "Document Access",
		tools: [
			{ name: "document_parse" },
			{ name: "document_search" },
			{ name: "document_screenshot" },
		],
	},
	{
		title: "Agents & Delegation",
		tools: [
			{ name: "subagent" },
			{ name: "hypatia_subagent_models" },
		],
	},
];

export function isPublicLivePackageToolName(name) {
	return livePackageToolGroups.some((group) => group.tools.some((tool) => tool.name === name));
}

export const cliCommandSections = [
	{
		title: "Core",
		commands: [
			{ usage: "hypatia", description: "Launch Graphite chat with a centered logo, citation-aware Markdown, grouped activity, contextual tips, and an F2 inbox for warnings." },
			{ usage: "hypatia chat [prompt]", description: "Start chat explicitly, optionally with an initial prompt." },
			{ usage: 'hypatia -- "- prompt"', description: "Start with a dash-leading research prompt after the end-of-options delimiter." },
			{ usage: 'hypatia --prompt="- prompt"', description: "Run a dash-leading research prompt once and exit." },
			{ usage: "hypatia help", description: "Show CLI help." },
			{ usage: "hypatia setup", description: "Run the guided setup wizard." },
			{ usage: "hypatia setup preview", description: "Install or verify preview dependencies." },
			{ usage: "hypatia doctor", description: "Diagnose config, auth, Pi runtime, and preview dependencies." },
			{ usage: "hypatia status", description: "Show the current setup summary." },
		],
	},
	{
		title: "Model Management",
		commands: [
			{ usage: "hypatia model list", description: "List available models in Pi auth storage." },
			{ usage: "hypatia model login [id]", description: "Authenticate a model provider with OAuth or API-key setup; legacy Azure settings migrate to `azure` on startup." },
			{ usage: "hypatia model logout [id]", description: "Clear stored auth for a model provider." },
			{ usage: "hypatia model set [provider/model]", description: "Set the default approved research model (also accepts provider:model); without one, pick from a list." },
			{ usage: "hypatia model routes [--json]", description: "Configure ordered routes for evidence-scout, scribe, auditor, critic, and reviser; choose Pi-override or parent-model inheritance, or inspect resolved routes as JSON." },
			{ usage: "hypatia model tier [value]", description: "View or set the request service tier override." },
		],
	},
	{
		title: "AlphaXiv",
		commands: [
			{ usage: "hypatia alpha login", description: "Sign in to alphaXiv." },
			{ usage: "hypatia alpha logout", description: "Clear alphaXiv auth." },
			{ usage: "hypatia alpha status", description: "Check alphaXiv auth status." },
			{ usage: 'hypatia alpha search "query"', description: "Search papers through Hypatia's bundled alphaXiv client." },
			{ usage: "hypatia alpha get <id-or-url>", description: "Fetch paper content and local annotations." },
			{ usage: 'hypatia alpha ask <id-or-url> "question"', description: "Ask a question about a paper." },
			{ usage: "hypatia alpha code <github-url> [path]", description: "Inspect a paper repository." },
			{ usage: "hypatia alpha annotate ...", description: "Read, write, list, or clear local paper notes." },
		],
	},
	{
		title: "Utilities",
		commands: [
			{ usage: "hypatia packages list", description: "Show core and optional Pi package presets." },
			{ usage: "hypatia packages install <preset>", description: "Install optional package presets on demand." },
			{ usage: "hypatia packages remove <preset>", description: "Remove an installed optional package preset." },
			{ usage: "hypatia search status", description: "Show Pi web-access status and config path." },
			{ usage: "hypatia search set <provider> [api-key]", description: "Set the web search provider and optionally save its API key." },
			{ usage: "hypatia search clear", description: "Reset web search provider to auto while preserving API keys." },
			{ usage: "hypatia update [package]", description: "Update optional Pi packages you installed, or one of them. Core packages update with Hypatia." },
		],
	},
];

export const legacyFlags = [
	{ usage: '--prompt "<text>"', description: "Run one prompt and exit." },
	{ usage: "--alpha-login", description: "Sign in to alphaXiv and exit." },
	{ usage: "--alpha-logout", description: "Clear alphaXiv auth and exit." },
	{ usage: "--alpha-status", description: "Show alphaXiv auth status and exit." },
	{ usage: "--model <provider/model|provider:model>", description: "Force a specific approved research model." },
	{ usage: "--service-tier <tier>", description: "Override request service tier for this run." },
	{ usage: "--thinking <level>", description: "Set thinking level: off | minimal | low | medium | high | xhigh | max." },
	{ usage: "--cwd <path>", description: "Set the working directory for tools." },
	{ usage: "--session-dir <path>", description: "Set the session storage directory." },
	{ usage: "--new-session", description: "Start a new persisted session." },
	{ usage: "--continue, -c", description: "Continue the most recent session (default for an interactive launch)." },
	{ usage: "--resume, -r", description: "Pick a previous session to resume." },
	{ usage: "--session <path|id>", description: "Open a specific session." },
	{ usage: "--fork <path|id>", description: "Fork a session into a new one." },
	{ usage: "--no-session", description: "Use an in-memory session that is not persisted." },
	{ usage: "--no-themes", description: "Skip theme loading (passed by ACP adapters such as pi-acp)." },
	{ usage: "--codemode", description: "Enable Pi Codemode for this session while keeping the default tools." },
	{ usage: "--export <session.jsonl> [out.html]", description: "Export a session file to HTML and exit." },
	{ usage: "--doctor", description: "Alias for `hypatia doctor`." },
	{ usage: "--setup-preview", description: "Alias for `hypatia setup preview`." },
];

export const topLevelCommandNames = ["alpha", "chat", "doctor", "help", "model", "packages", "search", "setup", "status", "update"];

export function formatSlashUsage(command) {
	return `/${command.name}${command.args ? ` ${command.args}` : ""}`;
}

export function formatCliWorkflowUsage(command) {
	return `hypatia ${command.name}${command.args ? ` ${command.args}` : ""}`;
}

export function getExtensionCommandSpec(name) {
	return extensionCommandSpecs.find((command) => command.name === name);
}

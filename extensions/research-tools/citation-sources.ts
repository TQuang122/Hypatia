import { spawn } from "node:child_process";
import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getExtensionCommandSpec } from "../../metadata/commands.mjs";

export type CitationSource = { title: string; url: string; identifier?: string; verification?: string };

export function extractCitationSources(markdown: string): CitationSource[] {
	const links = new Map<string, string>();
	for (const match of markdown.matchAll(/\[([^\]]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/giu)) links.set(match[2]!, match[1]!);
	for (const match of markdown.matchAll(/https?:\/\/[^\s<>`]+/giu)) {
		const url = match[0]!.replace(/[.,;!?]+$/u, "").replace(/\)+$/u, "");
		if (!links.has(url)) links.set(url, "");
	}
	for (const match of markdown.matchAll(/\b(?:doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/giu)) {
		const id = match[1]!.replace(/[.,;]+$/u, "");
		links.set(`https://doi.org/${id}`, links.get(`https://doi.org/${id}`) ?? "");
	}
	for (const match of markdown.matchAll(/\b(arXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?)/giu)) {
		const id = match[1]!.replace(/\s+/gu, "");
		links.set(`https://arxiv.org/abs/${id.slice(id.indexOf(":") + 1)}`, links.get(`https://arxiv.org/abs/${id.slice(id.indexOf(":") + 1)}`) ?? "");
	}
	return [...links].slice(0, 80).map(([url, title]) => {
		let identifier: string | undefined;
		try {
			const parsed = new URL(url);
			if (parsed.hostname.endsWith("doi.org")) identifier = `DOI:${decodeURIComponent(parsed.pathname.slice(1))}`;
			else if (parsed.hostname.endsWith("arxiv.org")) identifier = `arXiv:${parsed.pathname.split("/").pop()}`;
		} catch { /* URLs are validated again before opening. */ }
		const line = markdown.split("\n").find((item) => item.includes(url) || (identifier && item.toLowerCase().includes(identifier.toLowerCase()))) ?? "";
		const verification = /(?:verification(?: status)?|mức độ xác minh)\s*[:—-]\s*(verified|unverified|inferred|blocked)/iu.exec(line)?.[1]?.toLowerCase();
		let fallback = url;
		try { const parsed = new URL(url); fallback = parsed.hostname.replace(/^www\./u, "") + parsed.pathname; } catch { /* retain URL */ }
		return { title: title || identifier || fallback, url, ...(identifier ? { identifier } : {}), ...(verification ? { verification } : {}) };
	});
}

type SourcesContext = Pick<ExtensionCommandContext, "mode" | "hasUI" | "sessionManager" | "ui">;

function answerText(ctx: SourcesContext): string {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") continue;
		return entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	}
	return "";
}

function openSource(url: string): void {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only HTTP(S) source links can be opened.");
	const [command, args] = process.platform === "darwin" ? ["open", [url]]
		: process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

export async function runSourcesCommand(ctx: SourcesContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/sources requires the interactive TUI.", "warning"); return; }
	const sources = extractCitationSources(answerText(ctx));
	if (!sources.length) { ctx.ui.notify("No source links or DOI/arXiv identifiers in the latest answer.", "info"); return; }
	const labels = sources.map((source) => [source.title, source.identifier, source.verification, source.url].filter(Boolean).join(" · "));
	while (true) {
		const choice = await ctx.ui.select("Sources in latest answer", labels);
		if (!choice) return;
		const source = sources[labels.indexOf(choice)];
		if (!source) continue;
		const action = await ctx.ui.select(`${source.title}\n${source.identifier ?? ""}\n${source.url}`, ["Open URL", "Copy URL", "Back"]);
		try {
			if (action === "Open URL") openSource(source.url);
			else if (action === "Copy URL") { await copyToClipboard(source.url); ctx.ui.notify("Source URL copied", "info"); }
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
	}
}

export function registerCitationSourcesCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("sources", { description: getExtensionCommandSpec("sources")?.description ?? "Browse citations from the latest answer.", handler: async (_args, ctx) => runSourcesCommand(ctx) });
}

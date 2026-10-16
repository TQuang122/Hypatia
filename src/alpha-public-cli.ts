import { normalizePaperId, readAnnotation } from "@companion-ai/alpha-hub/lib";

import {
	alphaXivSearchPayload,
	discoverPublicAlphaXiv,
	findPublicAlphaXivImplementations,
	readPublicAlphaXivPaper,
	searchPublicAlphaXivFast,
} from "./alpha-public.js";
import type { AlphaXivSearchMode } from "./alpha-public.js";

export type AlphaPublicCliOptions = {
	fetchImpl?: typeof fetch;
	writeOutput?: (text: string) => void;
	readLocalAnnotation?: (paperId: string) => unknown;
};

function parseSearchArgs(args: string[]): {
	query: string;
	mode: string;
	publishedAfter?: string;
	publishedBefore?: string;
	prioritize?: string;
	limit?: number;
} | undefined {
	let mode = "semantic";
	let publishedAfter: string | undefined;
	let publishedBefore: string | undefined;
	let prioritize: string | undefined;
	let limit: number | undefined;
	const query: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--json" || arg === "--quiet") continue;
		const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		if (flag === "-m" || flag === "--mode" || flag === "--published-after" || flag === "--published-before" || flag === "--prioritize" || flag === "--limit") {
			const value = inlineValue ?? args[index + 1];
			if (!value) return undefined;
			if (inlineValue === undefined) index += 1;
			if (flag === "-m" || flag === "--mode") mode = value.toLowerCase();
			else if (flag === "--published-after") publishedAfter = value;
			else if (flag === "--published-before") publishedBefore = value;
			else if (flag === "--prioritize") prioritize = value.toLowerCase();
			else limit = Number(value);
			continue;
		}
		if (arg.startsWith("-")) return undefined;
		query.push(arg);
	}
	const cleaned = query.join(" ").trim();
	return cleaned ? {
		query: cleaned,
		mode,
		...(publishedAfter ? { publishedAfter } : {}),
		...(publishedBefore ? { publishedBefore } : {}),
		...(prioritize ? { prioritize } : {}),
		...(limit !== undefined ? { limit } : {}),
	} : undefined;
}

function parseGetArgs(args: string[]): { paper: string; fullText: boolean; json: boolean } | undefined {
	let fullText = false;
	let json = false;
	const paper: string[] = [];
	for (const arg of args) {
		if (arg === "--full-text") fullText = true;
		else if (arg === "--json") json = true;
		else if (arg.startsWith("-")) return undefined;
		else paper.push(arg);
	}
	if (paper.length !== 1) return undefined;
	return { paper: paper[0]!, fullText, json };
}

function parseImplementationsArgs(args: string[]): string | undefined {
	const paper = args.filter((arg) => !arg.startsWith("-"));
	if (args.some((arg) => arg.startsWith("-")) || paper.length !== 1) return undefined;
	return paper[0];
}

/** Handles the keyless CLI subset implemented against AlphaXiv's public endpoints. */
export async function runAlphaPublicCli(args: string[], options: AlphaPublicCliOptions = {}): Promise<boolean> {
	const [command, ...rest] = args;
	const write = options.writeOutput ?? ((text: string) => console.log(text));
	const fetchOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};

	if (command === "search") {
		const parsed = parseSearchArgs(rest);
		if (!parsed || !["semantic", "keyword", "both", "title"].includes(parsed.mode)) return false;
		if (parsed.mode === "title" && (parsed.publishedAfter || parsed.publishedBefore || parsed.prioritize)) {
			throw new Error("Date filters and ranking policies apply to semantic/keyword discovery, not fast title search.");
		}
		const searchOptions = {
			...fetchOptions,
			...(parsed.publishedAfter ? { publishedAfter: parsed.publishedAfter } : {}),
			...(parsed.publishedBefore ? { publishedBefore: parsed.publishedBefore } : {}),
			...(parsed.prioritize ? { prioritize: parsed.prioritize as "historical" | "default" | "recency" | "popular" } : {}),
			...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
		};
		let payload;
		if (parsed.mode === "both") {
			const [semantic, keyword] = await Promise.all([
				discoverPublicAlphaXiv(parsed.query, "embedding", searchOptions),
				discoverPublicAlphaXiv(parsed.query, "keyword", searchOptions),
			]);
			payload = alphaXivSearchPayload(parsed.query, "both", semantic, keyword, parsed.limit);
		} else {
			const mode = parsed.mode as AlphaXivSearchMode;
			const hits = mode === "title"
				? await searchPublicAlphaXivFast(parsed.query, fetchOptions)
				: await discoverPublicAlphaXiv(parsed.query, mode === "keyword" ? "keyword" : "embedding", searchOptions);
			payload = alphaXivSearchPayload(parsed.query, mode, hits, undefined, parsed.limit);
		}
		write(JSON.stringify(payload, null, 2));
		return true;
	}

	if (command === "implementations") {
		const paper = parseImplementationsArgs(rest);
		if (!paper) return false;
		const result = await findPublicAlphaXivImplementations(paper, fetchOptions);
		write(JSON.stringify(result, null, 2));
		return true;
	}

	if (command === "get") {
		const parsed = parseGetArgs(rest);
		if (!parsed) return false;
		const paper = await readPublicAlphaXivPaper(parsed.paper, parsed.fullText, fetchOptions);
		const annotation = (options.readLocalAnnotation ?? readAnnotation)(normalizePaperId(paper.paperId));
		if (parsed.json) {
			write(JSON.stringify({ content: paper.content, annotation }, null, 2));
		} else {
			const note = annotation && typeof annotation === "object" && "note" in annotation
				? String((annotation as { note: unknown }).note)
				: "";
			write(note ? `${paper.content}\n\n---\n[Local note]\n${note}` : paper.content);
		}
		return true;
	}

	return false;
}

type SearchParams = { query: string; source: string };
type LayaStatus = {
	state: "not_applicable" | "reranked" | "unavailable";
	message: string;
	abstractMissingCount?: number;
	device?: string;
	durationMs?: number;
	revision?: string;
	scoredCandidates?: number;
	truncatedCandidates?: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const LAYA_QUESTION = {
	relevance: {
		type: "choice",
		instructions: "Judge how useful this paper is for answering the research question.",
		criteria: {
			A: "Directly answers the question or supplies closely applicable evidence or methods.",
			B: "Unrelated, only tangential, or not useful for answering the question.",
		},
	},
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTopicSearch(params: SearchParams): boolean {
	const query = params.query.trim();
	if (!query) return false;
	if (!["semanticscholar", "openalex", "pubmed", "europepmc", "core"].includes(params.source)) return false;
	if (/^(?:doi|pmid|pmcid|arxiv|convert|related|fulltext|sections|copyright|citation|citations|references?|work|author|authors|source|venue)\s*:/iu.test(query)) {
		return false;
	}
	if (/^(?:openalex_(?!search_works\b)|rate-limit\b)/iu.test(query)) return false;
	if (/^(?:W\d+|10\.\d{4,9}\/\S+|\d{4}\.\d{4,5}(?:v\d+)?)$/iu.test(query)) return false;
	return true;
}

function loopbackOrigin(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("HYPATIA_LAYA_URL must be a loopback HTTP origin.");
	}
	if (
		url.protocol !== "http:"
		|| !["127.0.0.1", "[::1]"].includes(url.hostname)
		|| url.username
		|| url.password
		|| url.pathname !== "/"
		|| url.search
		|| url.hash
	) {
		throw new Error("HYPATIA_LAYA_URL must be an HTTP loopback origin on 127.0.0.1 or [::1].");
	}
	return url;
}

function positiveInteger(value: string | undefined, fallback: number, name: string, max: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	if (!/^[1-9]\d*$/u.test(value.trim())) throw new Error(`${name} must be a positive integer no greater than ${max}.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`${name} must be a positive integer no greater than ${max}.`);
	return parsed;
}

async function readJson(fetcher: typeof fetch, url: URL, timeoutMs: number, apiKey?: string): Promise<Record<string, unknown>> {
	const response = await fetcher(url, {
		headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return record(await response.json());
}

function stateFor(query: string, title: string, abstract: string | undefined): string {
	return [
		`Research question:\n${query}`,
		`Paper title: ${title}`,
		`Abstract: ${abstract ?? "not available"}`,
	].join("\n\n");
}

async function scoreCandidate(
	candidate: Record<string, unknown>,
	query: string,
	baseUrl: URL,
	timeoutMs: number,
	apiKey: string | undefined,
	fetcher: typeof fetch,
): Promise<{ score: number; choice: "A" | "B"; truncated: boolean }> {
	const title = text(candidate.title);
	if (!title) throw new Error("Candidate has no title.");
	const response = await fetcher(new URL("/v1/systemone", baseUrl), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: "english",
			state: stateFor(query, title, text(candidate.abstract)),
			questions: LAYA_QUESTION,
		}),
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const result = await response.json();
	const answer = record(record(record(result).answers).relevance);
	const probabilities = record(answer.probabilities);
	const score = probabilities.A;
	const choice = answer.choice;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1 || (choice !== "A" && choice !== "B")) {
		throw new Error("Invalid relevance response.");
	}
	return {
		score,
		choice,
		truncated: record(record(result).usage).truncated === true,
	};
}

function withStatus(result: Record<string, unknown>, status: LayaStatus): Record<string, unknown> {
	return { ...result, layaStatus: status };
}

export async function rerankScienceDatabaseResults(
	params: SearchParams,
	result: Record<string, unknown>,
	environment: NodeJS.ProcessEnv = process.env,
	fetcher: typeof fetch = globalThis.fetch,
): Promise<Record<string, unknown>> {
	if (environment.HYPATIA_LAYA_ENABLED !== "1") return result;
	if (!isTopicSearch(params)) {
		return withStatus(result, {
			state: "not_applicable",
			message: "Laya was not called: this is not a topical paper-discovery search.",
		});
	}
	const candidates = Array.isArray(result.results) ? result.results.map(record) : [];
	if (candidates.length < 2) {
		return withStatus(result, {
			state: "not_applicable",
			message: "Laya was not called: fewer than two paper results were returned.",
		});
	}

	const startedAt = performance.now();
	try {
		const baseUrl = loopbackOrigin(environment.HYPATIA_LAYA_URL ?? DEFAULT_BASE_URL);
		const timeoutMs = positiveInteger(environment.HYPATIA_LAYA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "HYPATIA_LAYA_TIMEOUT_MS", 60_000);
		const concurrency = positiveInteger(environment.HYPATIA_LAYA_CONCURRENCY, DEFAULT_CONCURRENCY, "HYPATIA_LAYA_CONCURRENCY", MAX_CONCURRENCY);
		const apiKey = environment.LAYA_API_KEY?.trim() || undefined;
		const initialHealth = await readJson(fetcher, new URL("/health", baseUrl), timeoutMs, apiKey);
		if (initialHealth.status !== "ok") throw new Error("Health probe did not report a live service.");

		const scored: Array<{ candidate: Record<string, unknown>; choice: "A" | "B"; originalRank: number; score: number; truncated: boolean }> = [];
		let truncatedCandidates = 0;
		for (let start = 0; start < candidates.length; start += concurrency) {
			const batch = candidates.slice(start, start + concurrency);
			const outcomes = await Promise.allSettled(batch.map((candidate, offset) =>
				scoreCandidate(candidate, params.query, baseUrl, timeoutMs, apiKey, fetcher).then((score) => ({
					candidate,
					choice: score.choice,
					originalRank: start + offset + 1,
					score: score.score,
					truncated: score.truncated,
				}))));
			const failed = outcomes.find((outcome) => outcome.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			for (const outcome of outcomes) {
				if (outcome.status !== "fulfilled") continue;
				if (outcome.value.truncated) truncatedCandidates += 1;
				scored.push(outcome.value);
			}
		}

		const health = await readJson(fetcher, new URL("/health", baseUrl), timeoutMs, apiKey);
		const revisions = record(health.revisions);
		const devices = record(health.checkpoint_devices);
		const revision = text(revisions.english);
		if (!revision) throw new Error("English checkpoint revision was not reported after inference.");

		const ranked = scored
			.sort((left, right) => right.score - left.score || left.originalRank - right.originalRank)
			.map(({ candidate, choice, originalRank, score, truncated }) => ({
				...candidate,
				layaScore: score,
				layaChoice: choice,
				layaOriginalRank: originalRank,
				layaTruncated: truncated,
				layaAbstractMissing: !text(candidate.abstract),
			}));
		const device = text(devices.english);
		const abstractMissingCount = candidates.filter((candidate) => !text(candidate.abstract)).length;
		const durationMs = Math.round(performance.now() - startedAt);
		return withStatus({ ...result, results: ranked }, {
			state: "reranked",
			message: `Laya reranked ${ranked.length} papers locally; original ranks are retained.`,
			abstractMissingCount,
			...(device ? { device } : {}),
			durationMs,
			revision,
			scoredCandidates: ranked.length,
			truncatedCandidates,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : "request failed";
		return withStatus(result, {
			state: "unavailable",
			message: `Laya was unavailable (${reason}); original order was retained.`,
			durationMs: Math.round(performance.now() - startedAt),
		});
	}
}

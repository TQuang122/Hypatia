#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { rerankScienceDatabaseResults } from "../extensions/research-tools/laya-reranker.ts";
import { summarizeLatencyTrials } from "./laya-pilot-metrics.mjs";

function readJsonl(path) {
	const name = path.split(/[\\/]/u).at(-1);
	return readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line, index) => {
		if (!line.trim()) return [];
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`${name} contains invalid JSON at line ${index + 1}.`);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${name} line ${index + 1} must contain an object.`);
		}
		return [value];
	});
}

function positiveInteger(value, flag, maximum = Number.MAX_SAFE_INTEGER) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`--${flag} must be an integer between 1 and ${maximum}.`);
	}
	return parsed;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function queryPool(rows, queryId) {
	const selected = rows.filter((row) => row.query_id === queryId);
	if (selected.length !== 20) throw new Error(`query ${queryId} must have exactly 20 candidates; found ${selected.length}.`);
	const firstQuery = selected[0]?.query;
	if (typeof firstQuery !== "string" || firstQuery.trim() === "") throw new Error(`query ${queryId} has no question text.`);
	const source = selected[0]?.retrieval_source;
	if (typeof source !== "string" || source.trim() === "") throw new Error(`query ${queryId} has no retrieval source.`);
	const ids = new Set();
	for (const [index, row] of selected.entries()) {
		if (row.query !== firstQuery) throw new Error(`query ${queryId} has inconsistent question text.`);
		if (row.retrieval_source !== source) throw new Error(`query ${queryId} has mixed retrieval sources.`);
		if (typeof row.candidate_id !== "string" || row.candidate_id.trim() === "") {
			throw new Error(`query ${queryId} candidate ${index + 1} has no ID.`);
		}
		if (typeof row.title !== "string" || row.title.trim() === "") {
			throw new Error(`query ${queryId} candidate ${index + 1} has no title.`);
		}
		if (typeof row.abstract !== "string") throw new Error(`query ${queryId} candidate ${index + 1} has an invalid abstract.`);
		if (ids.has(row.candidate_id)) throw new Error(`query ${queryId} has duplicate candidate ${row.candidate_id}.`);
		ids.add(row.candidate_id);
	}
	return selected;
}

async function main() {
	const { values } = parseArgs({
		options: {
			labels: { type: "string", default: "outputs/decision-model-systems-hypatia-heldout-labels.jsonl" },
			"query-id": { type: "string", default: "q07" },
			"base-url": { type: "string", default: "http://127.0.0.1:8000" },
			model: { type: "string", default: process.env.HYPATIA_LAYA_MODEL ?? "english" },
			"timeout-ms": { type: "string", default: "2000" },
			concurrency: { type: "string", default: "4" },
			repeats: { type: "string", default: "30" },
			output: { type: "string", default: "outputs/laya-hypatia-runtime-latency-smoke.json" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"Usage: node --import tsx evals/measure-laya-advisory-latency.mjs " +
			"[--labels <jsonl>] [--query-id q07] [--base-url <loopback-origin>] " +
			"[--model english] [--repeats 30] [--output <json>]\n",
		);
		return;
	}
	const labelsPath = resolve(values.labels ?? "");
	const labelsBytes = readFileSync(labelsPath);
	const queryId = values["query-id"]?.trim();
	if (!queryId) throw new Error("--query-id must be non-empty.");
	if (!values.model?.trim()) throw new Error("--model must be non-empty.");
	const timeoutMs = positiveInteger(values["timeout-ms"], "timeout-ms", 60_000);
	const concurrency = positiveInteger(values.concurrency, "concurrency", 8);
	const repeats = positiveInteger(values.repeats, "repeats", 1_000);
	if (repeats < 20) throw new Error("--repeats must be at least 20 for a useful p95 sample.");
	const outputPath = resolve(values.output ?? "");
	if (outputPath === labelsPath || existsSync(outputPath)) throw new Error("--output must be a new path, distinct from --labels.");

	const candidates = queryPool(readJsonl(labelsPath), queryId);
	const source = candidates[0].retrieval_source;
	const query = candidates[0].query;
	const searchResult = {
		source,
		...(source === "openalex" ? { mode: "work-search" } : source === "pubmed" ? { mode: "search" } : {}),
		returned: candidates.length,
		results: candidates.map((row) => ({
			candidateId: row.candidate_id,
			title: row.title,
			abstract: row.abstract,
		})),
	};
	const environment = {
		...process.env,
		HYPATIA_LAYA_ENABLED: "1",
		HYPATIA_LAYA_URL: values["base-url"],
		HYPATIA_LAYA_MODEL: values.model,
		HYPATIA_LAYA_TIMEOUT_MS: String(timeoutMs),
		HYPATIA_LAYA_CONCURRENCY: String(concurrency),
	};
	const run = () => rerankScienceDatabaseResults({ source, query }, searchResult, environment);
	const warmup = await run();
	if (warmup.layaStatus?.state !== "advisory") {
		throw new Error(`Laya warmup failed: ${warmup.layaStatus?.message ?? "no status returned"}`);
	}
	const candidateIds = candidates.map((row) => row.candidate_id);
	const trials = [];
	for (let index = 0; index < repeats; index += 1) {
		const result = await run();
		const status = result.layaStatus ?? {};
		const returnedIds = Array.isArray(result.results) ? result.results.map((row) => row.candidateId) : [];
		if (returnedIds.join("\n") !== candidateIds.join("\n")) {
			throw new Error(`Hypatia changed source order during latency trial ${index + 1}.`);
		}
		trials.push({
			state: status.state,
			durationMs: status.durationMs,
			scoredCandidates: status.scoredCandidates ?? 0,
			truncatedCandidates: status.truncatedCandidates ?? 0,
		});
	}
	const summary = summarizeLatencyTrials(trials, candidates.length);
	const report = {
		benchmark: "hypatia-laya-warm-advisory-latency",
		scope: "one existing 20-candidate query repeated for runtime diagnostics; not the full quality gate",
		input: {
			labels: labelsPath.split(/[\\/]/u).at(-1),
			sha256: sha256(labelsBytes),
			queryId,
			source,
			candidateCount: candidates.length,
			titleOnlyCandidates: candidates.filter((row) => row.abstract.trim() === "").length,
		},
		model: {
			alias: values.model,
			revision: warmup.layaStatus.revision,
			device: warmup.layaStatus.device,
		},
		warmup: {
			state: warmup.layaStatus.state,
			durationMs: warmup.layaStatus.durationMs,
			truncatedCandidates: warmup.layaStatus.truncatedCandidates,
		},
		trials: { ...summary, repeats },
		thresholds: {
			minimumCandidateSuccessRate: 0.99,
			maximumTruncationRate: 0.05,
			maximumWarmP95Ms: 10_000,
		},
	};
	const outputText = `${JSON.stringify(report, null, 2)}\n`;
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, outputText, { flag: "wx", mode: 0o600 });
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`Laya advisory latency measurement failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

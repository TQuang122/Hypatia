#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadCandidateRows, localOrigin, parseCutoffs } from "./laya-pilot-input.mjs";
import { evaluateRankings } from "./laya-pilot-metrics.mjs";

const RELEVANCE_QUESTION = {
	relevance: {
		type: "choice",
		instructions: "Judge how useful this paper is for answering the research question.",
		criteria: {
			A: "Directly answers the question or supplies closely applicable evidence or methods.",
			B: "Unrelated, only tangential, or not useful for answering the question.",
		},
	},
};

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonResponse(response, context) {
	try {
		return await response.json();
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Laya returned invalid JSON for ${context}.`);
		throw error;
	}
}

function candidateState(candidate) {
	return `Research question:\n${candidate.query}\n\nPaper title: ${candidate.title}\n\nAbstract: ${candidate.abstract}`;
}

async function scoreCandidate(candidate, baseUrl, timeoutMs, apiKey) {
	const headers = { "content-type": "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await fetch(new URL("/v1/systemone", baseUrl), {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "english",
			state: candidateState(candidate),
			questions: RELEVANCE_QUESTION,
		}),
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`Laya returned HTTP ${response.status} for candidate ${candidate.candidateId}.`);
	const result = await readJsonResponse(response, `candidate ${candidate.candidateId}`);
	if (!isRecord(result) || !isRecord(result.answers) || !isRecord(result.answers.relevance)) {
		throw new Error(`Laya returned an invalid answer for candidate ${candidate.candidateId}.`);
	}
	const answer = result.answers.relevance;
	const probabilities = answer.probabilities;
	const score = isRecord(probabilities) ? probabilities.A : undefined;
	const choice = answer.choice;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1 || (choice !== "A" && choice !== "B")) {
		throw new Error(`Laya returned an invalid relevance score for candidate ${candidate.candidateId}.`);
	}
	const usage = isRecord(result.usage) ? result.usage : {};
	const routing = isRecord(result.routing) ? result.routing : {};
	return {
		...candidate,
		layaScore: score,
		layaChoice: choice,
		layaTruncated: usage.truncated === true,
		layaModel: typeof routing.model === "string" ? routing.model : "english",
		layaRepo: typeof routing.repo === "string" ? routing.repo : null,
	};
}

async function modelMetadata(baseUrl, timeoutMs, apiKey) {
	const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
	const response = await fetch(new URL("/health", baseUrl), {
		headers,
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`Laya health returned HTTP ${response.status}.`);
	const health = await readJsonResponse(response, "health endpoint");
	if (!isRecord(health) || !isRecord(health.revisions) || typeof health.revisions.english !== "string") {
		throw new Error("Laya health did not report the loaded English checkpoint revision.");
	}
	const devices = isRecord(health.checkpoint_devices) ? health.checkpoint_devices : {};
	return {
		revision: health.revisions.english,
		device: typeof devices.english === "string" ? devices.english : null,
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			labels: { type: "string" },
			"jev-rankings": { type: "string" },
			"base-url": { type: "string", default: "http://127.0.0.1:8000" },
			cutoffs: { type: "string", default: "5,10" },
			"timeout-ms": { type: "string", default: "600000" },
			output: { type: "string" },
		},
	});
	if (!values.labels) {
		throw new Error("Usage: node evals/laya-pilot.mjs --labels <jsonl-or-csv> [--jev-rankings <jsonl-or-csv>] [--base-url http://127.0.0.1:8000] [--output <new-json-file>]");
	}
	const baseUrl = localOrigin(values["base-url"] ?? "http://127.0.0.1:8000");
	const cutoffs = parseCutoffs(values.cutoffs ?? "5,10");
	const timeoutMs = Number(values["timeout-ms"] ?? "600000");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeout-ms must be a positive integer.");
	if (values.output && existsSync(resolve(values.output))) throw new Error("output file already exists; choose a new path.");

	const input = loadCandidateRows(values.labels, values["jev-rankings"] ?? null);
	const apiKey = process.env.LAYA_API_KEY?.trim() ?? "";
	const scored = [];
	for (const candidate of input.rows) {
		scored.push(await scoreCandidate(candidate, baseUrl, timeoutMs, apiKey));
	}
	const localModel = await modelMetadata(baseUrl, timeoutMs, apiKey);
	const summary = {
		benchmark: "local-paper-triage",
		model: {
			checkpoint: "english",
			revision: localModel.revision,
			device: localModel.device,
			repositories: [...new Set(scored.flatMap((row) => row.layaRepo ? [row.layaRepo] : []))],
			routedModels: [...new Set(scored.map((row) => row.layaModel))],
		},
		inputs: {
			labels: input.label,
			jevRankings: input.jev,
		},
		cutoffs,
		metrics: evaluateRankings(scored, cutoffs),
		candidateScores: scored.map((row) => ({
			queryId: row.queryId,
			candidateId: row.candidateId,
			relevance: row.relevance,
			jevRank: row.jevRank,
			layaScore: row.layaScore,
			layaChoice: row.layaChoice,
			layaTruncated: row.layaTruncated,
		})),
	};
	const output = `${JSON.stringify(summary, null, 2)}\n`;
	if (values.output) writeFileSync(resolve(values.output), output, { flag: "wx" });
	process.stdout.write(output);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Laya pilot failed: ${message}\n`);
	process.exitCode = 1;
});

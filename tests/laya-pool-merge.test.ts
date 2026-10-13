import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { mergeBlindedCandidatePools } from "../evals/merge-hypatia-laya-pools.mjs";

function candidate(queryId: string, candidateId: string, rank: number, relevance: null | number = null) {
	return {
		query_id: queryId,
		candidate_id: candidateId,
		query: `Question ${queryId}`,
		title: `Paper ${candidateId}`,
		abstract: candidateId === "title-only" ? "" : "Abstract.",
		relevance,
		abstract_missing: candidateId === "title-only",
		retrieval_source: "openalex",
	};
}

function ranking(queryId: string, candidateId: string, baselineRank: number) {
	return { query_id: queryId, candidate_id: candidateId, baseline_rank: baselineRank, source: "openalex" };
}

function jsonl(rows: Array<Record<string, unknown>>): string {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function runMerge(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [resolve("evals/merge-hypatia-laya-pools.mjs"), ...args], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!child.stdout || !child.stderr) throw new Error("Pool-merge command streams were unavailable");
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const code = await new Promise<number | null>((resolveCode, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Hypatia pool-merge command did not exit within 30 seconds."));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timeout);
			resolveCode(exitCode);
		});
	});
	return {
		code,
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
	};
}

test("merges blinded pools while preserving source ranks and query identity", () => {
	const existingLabels = [candidate("q07", "a", 1), candidate("q07", "title-only", 2)];
	const existingRanks = [ranking("q07", "a", 1), ranking("q07", "title-only", 2)];
	const additionalLabels = [candidate("q13", "b", 1)];
	const additionalRanks = [ranking("q13", "b", 1)];

	const merged = mergeBlindedCandidatePools(
		{ labels: existingLabels, rankings: existingRanks },
		{ labels: additionalLabels, rankings: additionalRanks },
	);

	assert.deepEqual(merged.labels, [...existingLabels, ...additionalLabels]);
	assert.deepEqual(merged.rankings, [...existingRanks, ...additionalRanks]);
	assert.equal(merged.doubleLabels.length, 2);
	assert.ok(merged.doubleLabels.every((row) => row.relevance === null));
	assert.deepEqual([...merged.doubleLabels.map((row) => row.query_id)].sort(), ["q07", "q13"]);
	assert.deepEqual(merged.summary.queryIds, ["q07", "q13"]);
	assert.equal(merged.summary.queries, 2);
	assert.equal(merged.summary.candidates, 3);
	assert.equal(merged.summary.titleOnlyCandidates, 1);
	assert.deepEqual(merged.summary.doubleLabelPlan.perQuery, { q07: 1, q13: 1 });
	assert.ok(merged.labels.every((row) => row.relevance === null));
});

test("pool-merge CLI writes a hashed, still-blinded combined annotation package", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-pool-merge-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const existingLabels = join(directory, "existing-labels.jsonl");
	const existingRanks = join(directory, "existing-ranks.jsonl");
	const additionalLabels = join(directory, "additional-labels.jsonl");
	const additionalRanks = join(directory, "additional-ranks.jsonl");
	const labelsOutput = join(directory, "combined-labels.jsonl");
	const doubleLabelsOutput = join(directory, "double-labels.jsonl");
	const rankingsOutput = join(directory, "combined-ranks.jsonl");
	const summaryOutput = join(directory, "summary.json");
	const firstLabelRows = [candidate("q07", "a", 1), candidate("q07", "title-only", 2)];
	const firstRankRows = [ranking("q07", "a", 1), ranking("q07", "title-only", 2)];
	const nextLabelRows = [candidate("q13", "b", 1)];
	const nextRankRows = [ranking("q13", "b", 1)];
	await Promise.all([
		writeFile(existingLabels, jsonl(firstLabelRows)),
		writeFile(existingRanks, jsonl(firstRankRows)),
		writeFile(additionalLabels, jsonl(nextLabelRows)),
		writeFile(additionalRanks, jsonl(nextRankRows)),
	]);

	const result = await runMerge([
		"--existing-labels", existingLabels,
		"--existing-rankings", existingRanks,
		"--additional-labels", additionalLabels,
		"--additional-rankings", additionalRanks,
		"--labels-output", labelsOutput,
		"--double-labels-output", doubleLabelsOutput,
		"--rankings-output", rankingsOutput,
		"--summary-output", summaryOutput,
	]);

	assert.equal(result.code, 0, result.stderr);
	const labels = (await readFile(labelsOutput, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const summary = JSON.parse(await readFile(summaryOutput, "utf8")) as {
		queries: number;
		candidates: number;
		titleOnlyCandidates: number;
		doubleLabelPlan: { candidates: number; targetFraction: number };
		inputs: { existingLabels: { sha256: string } };
		outputs: { labels: { sha256: string } };
	};
	assert.equal(labels.length, 3);
	assert.ok(labels.every((row) => row.relevance === null));
	const doubleLabels = (await readFile(doubleLabelsOutput, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(summary.queries, 2);
	assert.equal(summary.candidates, 3);
	assert.equal(summary.titleOnlyCandidates, 1);
	assert.equal(summary.doubleLabelPlan.targetFraction, 0.2);
	assert.equal(summary.doubleLabelPlan.candidates, 2);
	assert.equal(doubleLabels.length, 2);
	assert.ok(doubleLabels.every((row) => row.relevance === null));
	assert.match(summary.inputs.existingLabels.sha256, /^[a-f0-9]{64}$/u);
	assert.match(summary.outputs.labels.sha256, /^[a-f0-9]{64}$/u);
});

test("blinded pool merge rejects overlapping query IDs", () => {
	assert.throws(() => mergeBlindedCandidatePools(
		{ labels: [candidate("q07", "a", 1)], rankings: [ranking("q07", "a", 1)] },
		{ labels: [candidate("q07", "b", 1)], rankings: [ranking("q07", "b", 1)] },
	), /query IDs overlap/u);
});

test("blinded pool merge rejects changed labels and mismatched ranking keys", () => {
	assert.throws(() => mergeBlindedCandidatePools(
		{ labels: [candidate("q07", "a", 1, 2)], rankings: [ranking("q07", "a", 1)] },
		{ labels: [candidate("q13", "b", 1)], rankings: [ranking("q13", "b", 1)] },
	), /relevance must remain null/u);
	assert.throws(() => mergeBlindedCandidatePools(
		{ labels: [candidate("q07", "a", 1)], rankings: [ranking("q07", "wrong", 1)] },
		{ labels: [candidate("q13", "b", 1)], rankings: [ranking("q13", "b", 1)] },
	), /candidate IDs do not match/u);
});

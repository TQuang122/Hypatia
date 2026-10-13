import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { balanceTrainingRows, splitRowsByQuery } from "../evals/laya-pilot-input.mjs";
import {
	prepareLayaTrainingData,
	prepareLayaTrainingOnlyData,
} from "../evals/prepare-laya-training-data.mjs";

async function runPreparation(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [resolve("evals/prepare-laya-training-data.mjs"), ...args], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!child.stdout || !child.stderr) throw new Error("Training-data command streams were unavailable");
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const code = await new Promise<number | null>((resolveCode, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Laya training-data command did not exit within 30 seconds."));
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

function jsonlRows(rows: Array<Record<string, unknown>>): string {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("training-label balancing deterministically downsamples only the training rows", () => {
	const rows = [
		{ queryId: "q1", query: "question one", candidateId: "a", relevance: 3, abstract: "Evidence." },
		{ queryId: "q1", query: "question one", candidateId: "b", relevance: 2, abstract: "Evidence." },
		{ queryId: "q1", query: "question one", candidateId: "c", relevance: 1, abstract: "Partial." },
		{ queryId: "q2", query: "question two", candidateId: "d", relevance: 3, abstract: "Evidence." },
		{ queryId: "q2", query: "question two", candidateId: "e", relevance: 0, abstract: "" },
		{ queryId: "q3", query: "question three", candidateId: "f", relevance: 2, abstract: "Evidence." },
	];
	const first = balanceTrainingRows(rows, { seed: "balance-test" });
	const second = balanceTrainingRows(rows, { seed: "balance-test" });

	assert.deepEqual(first.rows.map((row) => row.candidateId), second.rows.map((row) => row.candidateId));
	assert.equal(first.before.answerUsefulCandidates, 4);
	assert.equal(first.before.notUsefulCandidates, 2);
	assert.equal(first.after.answerUsefulCandidates, 2);
	assert.equal(first.after.notUsefulCandidates, 2);
	assert.equal(first.rows.length, 4);
	assert.equal(new Set(first.rows.map((row) => row.candidateId)).size, first.rows.length);
});

test("Laya data preparation balances only training rows and keeps query groups disjoint", () => {
	const result = prepareLayaTrainingData([
		{ queryId: "train-1", query: "training question", candidateId: "a", title: "Useful", abstract: "Evidence.", relevance: 3 },
		{ queryId: "train-1", query: "training question", candidateId: "b", title: "Relevant", abstract: "Evidence.", relevance: 2 },
		{ queryId: "train-1", query: "training question", candidateId: "c", title: "Partial", abstract: "Context.", relevance: 1 },
		{ queryId: "train-2", query: "another training question", candidateId: "d", title: "Unrelated", abstract: "", relevance: 0 },
	], [
		{ queryId: "holdout-1", query: "held-out question", candidateId: "e", title: "Useful", abstract: "Evidence.", relevance: 2 },
		{ queryId: "holdout-1", query: "held-out question", candidateId: "f", title: "Partial", abstract: "", relevance: 1 },
		{ queryId: "holdout-1", query: "held-out question", candidateId: "g", title: "Unrelated", abstract: "No match.", relevance: 0 },
	], { seed: "prepared-data-test" });

	assert.equal(result.train.length, 4);
	assert.equal(result.holdout.length, 3);
	assert.deepEqual(result.summary.train.queryIds, ["train-1", "train-2"]);
	assert.deepEqual(result.summary.holdout.queryIds, ["holdout-1"]);
	assert.equal(result.summary.train.balance.after.answerUsefulCandidates, 2);
	assert.equal(result.summary.train.balance.after.notUsefulCandidates, 2);
	assert.deepEqual(result.holdout.map((row) => row.expected.relevance).sort(), ["A", "B", "B"]);
	assert.ok(result.holdout.some((row) => row.state.endsWith("Abstract: not available")));
});

test("training-only preparation labels its scope and does not invent a holdout", () => {
	const result = prepareLayaTrainingOnlyData([
		{ queryId: "train-1", query: "training question", candidateId: "a", title: "Useful", abstract: "Evidence.", relevance: 3 },
		{ queryId: "train-1", query: "training question", candidateId: "b", title: "Partial", abstract: "Context.", relevance: 1 },
		{ queryId: "train-2", query: "another question", candidateId: "c", title: "Relevant", abstract: "Evidence.", relevance: 2 },
		{ queryId: "train-2", query: "another question", candidateId: "d", title: "Unrelated", abstract: "", relevance: 0 },
	], { seed: "training-only-test" });

	assert.equal(result.train.length, 4);
	assert.equal(result.summary.scope, "training-only; no held-out query evaluation");
	assert.equal(result.summary.holdout, null);
	assert.deepEqual(result.train.map((row) => row.expected.relevance).sort(), ["A", "A", "B", "B"]);
});

test("training-data CLI writes balanced train and untouched query-disjoint holdout files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-training-data-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const trainLabels = join(directory, "train-labels.jsonl");
	const trainRanks = join(directory, "train-ranks.jsonl");
	const holdoutLabels = join(directory, "holdout-labels.jsonl");
	const holdoutRanks = join(directory, "holdout-ranks.jsonl");
	const outputDir = join(directory, "prepared");
	const train = [
		{ query_id: "train-1", query: "training one", candidate_id: "a", title: "Useful", abstract: "Evidence.", relevance: 3 },
		{ query_id: "train-1", query: "training one", candidate_id: "b", title: "Unrelated", abstract: "", relevance: 0 },
		{ query_id: "train-2", query: "training two", candidate_id: "c", title: "Useful", abstract: "Evidence.", relevance: 2 },
		{ query_id: "train-2", query: "training two", candidate_id: "d", title: "Partial", abstract: "Context.", relevance: 1 },
	];
	const holdout = [
		{ query_id: "holdout-1", query: "held-out", candidate_id: "e", title: "Useful", abstract: "Evidence.", relevance: 3 },
		{ query_id: "holdout-1", query: "held-out", candidate_id: "f", title: "Partial", abstract: "", relevance: 1 },
		{ query_id: "holdout-1", query: "held-out", candidate_id: "g", title: "Unrelated", abstract: "No match.", relevance: 0 },
	];
	await Promise.all([
		writeFile(trainLabels, jsonlRows(train)),
		writeFile(trainRanks, jsonlRows(train.map((row, index) => ({
			query_id: row.query_id,
			candidate_id: row.candidate_id,
			baseline_rank: index % 2 + 1,
		})))),
		writeFile(holdoutLabels, jsonlRows(holdout)),
		writeFile(holdoutRanks, jsonlRows(holdout.map((row, index) => ({
			query_id: row.query_id,
			candidate_id: row.candidate_id,
			baseline_rank: index + 1,
		})))),
	]);

	const result = await runPreparation([
		"--train-labels", trainLabels,
		"--train-rankings", trainRanks,
		"--holdout-labels", holdoutLabels,
		"--holdout-rankings", holdoutRanks,
		"--output-dir", outputDir,
	]);

	assert.equal(result.code, 0, result.stderr);
	const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8")) as {
		train: { balance: { after: { answerUsefulCandidates: number; notUsefulCandidates: number } } };
		holdout: { candidates: number; answerUsefulCandidates: number; notUsefulCandidates: number };
	};
	const trainCases = (await readFile(join(outputDir, "train.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const holdoutCases = (await readFile(join(outputDir, "holdout.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(trainCases.length, 4);
	assert.equal(holdoutCases.length, 3);
	assert.equal(summary.train.balance.after.answerUsefulCandidates, 2);
	assert.equal(summary.train.balance.after.notUsefulCandidates, 2);
	assert.equal(summary.holdout.candidates, 3);
	assert.equal(summary.holdout.answerUsefulCandidates, 1);
	assert.equal(summary.holdout.notUsefulCandidates, 2);

	const trainingOnlyDir = join(directory, "training-only");
	const trainingOnlyResult = await runPreparation([
		"--training-only",
		"--train-labels", trainLabels,
		"--train-rankings", trainRanks,
		"--output-dir", trainingOnlyDir,
	]);
	assert.equal(trainingOnlyResult.code, 0, trainingOnlyResult.stderr);
	const trainingOnlySummary = JSON.parse(await readFile(join(trainingOnlyDir, "summary.json"), "utf8")) as {
		scope: string;
		holdout: null;
	};
	assert.equal(trainingOnlySummary.scope, "training-only; no held-out query evaluation");
	assert.equal(trainingOnlySummary.holdout, null);
	assert.equal(await readFile(join(trainingOnlyDir, "train.jsonl"), "utf8").then((text) => text.trim().split("\n").length), 4);
	await assert.rejects(readFile(join(trainingOnlyDir, "holdout.jsonl")));
});

test("Laya train and holdout splits keep each query wholly on one side", () => {
	const rows = [
		{ queryId: "q1", query: "question one", candidateId: "a", relevance: 3, abstract: "Evidence." },
		{ queryId: "q1", query: "question one", candidateId: "b", relevance: 0, abstract: "" },
		{ queryId: "q2", query: "question two", candidateId: "c", relevance: 1, abstract: "Context." },
		{ queryId: "q2", query: "question two", candidateId: "d", relevance: 0, abstract: "" },
		{ queryId: "q3", query: "question three", candidateId: "e", relevance: 0, abstract: "Unrelated." },
		{ queryId: "q3", query: "question three", candidateId: "f", relevance: 0, abstract: "" },
		{ queryId: "q4", query: "question four", candidateId: "g", relevance: 2, abstract: "Evidence." },
		{ queryId: "q4", query: "question four", candidateId: "h", relevance: 3, abstract: "Direct evidence." },
	];
	const options = { testQueryIds: ["q1", "q4"] };
	const first = splitRowsByQuery(rows, options);
	const second = splitRowsByQuery(rows, options);

	assert.deepEqual(first.testQueryIds, ["q1", "q4"]);
	assert.deepEqual(first.testQueryIds, second.testQueryIds);
	assert.deepEqual(first.trainQueryIds, second.trainQueryIds);
	assert.equal(first.trainQueryIds.length, 2);
	assert.equal(first.testQueryIds.length, 2);
	assert.equal(first.trainRows.length + first.testRows.length, rows.length);
	assert.equal(first.trainRows.some((row) => first.testQueryIds.includes(row.queryId)), false);
	assert.equal(first.testRows.some((row) => first.trainQueryIds.includes(row.queryId)), false);
	for (const queryId of [...first.trainQueryIds, ...first.testQueryIds]) {
		const split = first.trainQueryIds.includes(queryId) ? first.trainRows : first.testRows;
		assert.ok(split.filter((row) => row.queryId === queryId).length > 0);
	}
	assert.equal(first.trainSummary.candidates, first.trainRows.length);
	assert.equal(first.testSummary.candidates, first.testRows.length);
	assert.equal(
		first.trainSummary.relevantCandidates + first.trainSummary.nonRelevantCandidates,
		first.trainRows.length,
	);
});

test("query-level split rejects impossible held-out query counts", () => {
	assert.throws(() => splitRowsByQuery([
		{ queryId: "q1", query: "question", candidateId: "a", relevance: 1, abstract: "" },
	], { testQueryIds: ["q1"] }), /at least two distinct queries/u);
	const rows = [
		{ queryId: "q1", query: "question one", candidateId: "a", relevance: 1, abstract: "" },
		{ queryId: "q2", query: "question two", candidateId: "b", relevance: 0, abstract: "" },
	];
	assert.throws(() => splitRowsByQuery([
		...rows,
	], { testQueryIds: ["q1", "q2"] }), /leave at least one training query/u);
	assert.throws(() => splitRowsByQuery(rows, { testQueryIds: ["q3"] }), /not present in candidate rows/u);
});
